# Wissensraum

Eine selbst gehostete Wissens-Chat-Anwendung für Linux: externe JWT-Identität, lokale Rollen, Gemini-Antworten mit Quellenbelegen, asynchrone Wissensindexierung und abgesicherte PM2-Updates. Oberfläche und Dokumentation sind auf Deutsch.

## Enthalten

- Chat mit Streaming, Abbruch, Markdown und ausklappbaren Originalauszügen. Der komplette Gesprächsverlauf wird bei jeder Anfrage erneut übergeben, solange er in das Kontextfenster passt. Keine Chat- oder Nachrichtentabellen.
- Rollen `admin`, `editor` und `user` aus SQLite. Der erste gültige Login wird atomar zum Admin. JWT-Rollen werden ignoriert; der letzte aktive Admin bleibt geschützt.
- Wissen per Text, `!learn`, Datei oder URL. PDF, DOCX, XLSX, CSV, TXT und Markdown werden unterstützt. Deaktivieren, Löschen und erneutes Indexieren vorhandener Quellen.
- Hintergrundaufträge mit Fortschritt, Leasing, Wiederaufnahme und Fehleranzeige. Same-Hostname-Crawler mit Tiefe 2, robots.txt und SSRF-Schutz einschließlich geprüfter, festgehaltener DNS-Adressen.
- Verschlüsselt gespeicherter Gemini-Schlüssel, paginierte dynamische Modellabfrage, Funktionstest und getrennte Auswahl von Chat- und Embedding-Modell.
- Ein Update-Klick startet Backup, `git pull --ff-only`, `npm install`, Build, Tests, Migrationen und PM2-Neustart. Fehler stellen Git, SQLite, Abhängigkeiten und Frontend aus dem vorherigen Stand wieder her.

## Architektur

Node.js **24 LTS**, Express 5, React 19/Vite, `better-sqlite3`, `jose`. Die Gemini-Anbindung verwendet die dokumentierte REST-API direkt; ein zusätzliches KI-SDK ist nicht nötig. SQLite läuft im WAL-Modus mit Fremdschlüsseln und vollständiger Synchronisierung. Die Anwendung benötigt weder Redis noch einen externen Datenbank- oder Vektorserver.

| Verzeichnis                       | Verantwortung                                                      |
| --------------------------------- | ------------------------------------------------------------------ |
| `server/routes/`                  | Rollenabhängige API für Quellen und Administration                 |
| `server/auth.mjs`                 | JWT-Prüfung, Cookie-Austausch, lokale Benutzerrollen               |
| `server/db/`                      | Verbindung, Migrationen mit Prüfsummen, Einstellungen              |
| `server/services/`                | Gemini, Chunking, sichere HTTP-Zugriffe, Crawler, Job-Verarbeitung |
| `server/workers/indexer.mjs`      | Persistente Job-Warteschlange im eigenen PM2-Prozess               |
| `server/workers/extract-file.mjs` | Zeitlich und speicherseitig begrenzte Datei-Ausleseprozesse        |
| `server/workers/retrieval.mjs`    | Vektorsuche in einem Worker-Thread außerhalb des HTTP-Event-Loops  |
| `web/src/`                        | Responsive React-Oberfläche und API-Client                         |
| `ops/`                            | Unabhängiger Update-Daemon, Update-Runner, Reverse-Proxy-Beispiel  |
| `scripts/`                        | Migration, Online-Backup, Syntaxprüfung                            |
| `tests/`                          | Sicherheits-, Import-, RAG- und Rollback-Tests ohne Cloud-Zugang   |

Drei PM2-Prozesse laufen jeweils **einmal im Fork-Modus**: `wissensraum-web`, `wissensraum-worker`, `wissensraum-updater`. Der Worker verarbeitet Quellen nacheinander; der Webserver beantwortet währenddessen weiter Anfragen. Vektorsuche und Datei-Extraktion blockieren den HTTP-Event-Loop nicht.

## Ersteinrichtung unter Linux

Voraussetzungen: Node.js 24 mit npm, Git, `flock` aus `util-linux`, OpenSSL und ein HTTPS-Reverse-Proxy. Ein System mit 2 GB RAM ist ein sinnvoller Ausgangspunkt; Umfang und Komplexität der Dateien bestimmen den tatsächlichen Bedarf. Für Builds und Updates ausreichend freien Speicher für die installierten Pakete, das Frontend und die gesamte SQLite-Datei vorhalten.

### 1. Projekt vorbereiten

Das Projekt zunächst in dein öffentliches GitHub-Repository übernehmen. `OWNER/REPOSITORY` und `wissen.example.org` in den folgenden Beispielen ersetzen. `private: true` in `package.json` verhindert nur versehentliches Veröffentlichen auf npm; das GitHub-Repository kann öffentlich sein.

Als Serveradministrator einmalig, beispielsweise auf Debian/Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y git build-essential python3 util-linux openssl
sudo useradd --create-home --shell /bin/bash wissensraum
sudo install -d -o wissensraum -g wissensraum -m 750 /opt/wissensraum
sudo install -d -o wissensraum -g wissensraum -m 700 /var/lib/wissensraum
```

Node.js 24 vorher über die auf dem Server übliche, vertrauenswürdige Installationsmethode installieren. `node --version` muss `v24.x` ausgeben. Die Anwendung selbst und PM2 anschließend als unprivilegierter Dienstbenutzer betreiben:

```bash
sudo -iu wissensraum
git clone https://github.com/OWNER/REPOSITORY.git /opt/wissensraum
cd /opt/wissensraum
npm ci --include=dev --no-audit --no-fund
export PATH="$PWD/node_modules/.bin:$PATH"
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Die generierten 64 Hex-Zeichen in `APP_ENCRYPTION_KEY` eintragen. Außerdem Origin und JWT-Vertrauenskonfiguration ausfüllen. Der Schlüssel muss über Neustarts und Updates unverändert bleiben und separat gesichert werden. Eine neue Zufallszahl bei jedem Start würde gespeicherte API-Schlüssel unlesbar machen.

### 2. Datenbank und Oberfläche vorbereiten

```bash
npm run db:migrate
npm run check
npm test
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

PM2 ist mit geprüfter Version und Unterabhängigkeiten im Projekt enthalten. Für manuelle Befehle in einer neuen Shell zuerst `cd /opt/wissensraum` und `export PATH="$PWD/node_modules/.bin:$PATH"` ausführen. Eine zusätzliche globale Installation ist nicht erforderlich; auch der Updater verwendet diese lokale Version.

Den von `pm2 startup` ausgegebenen Systembefehl als Administrator ausführen, anschließend als Dienstbenutzer noch einmal `pm2 save`. Alle PM2-Befehle für diese Anwendung müssen mit demselben Betriebssystembenutzer und derselben PM2-Instanz ausgeführt werden.

Bei einer externen Konfigurationsdatei statt `.env`:

```bash
CONFIG_FILE=/etc/wissensraum/app.env pm2 start ecosystem.config.cjs
```

Diese Datei muss für den Dienstbenutzer lesbar sein. Der absolute Pfad wird in der PM2-Konfiguration weitergegeben. Für manuelle Datenbankbefehle ebenfalls `CONFIG_FILE` setzen.

### 3. HTTPS und erster Administrator

Den HTTPS-Reverse-Proxy anhand von `ops/nginx.conf.example` einrichten. Zertifikat und Domain werden in der vorhandenen Serververwaltung eingerichtet. `APP_ORIGIN` muss exakt die öffentliche Origin enthalten, beispielsweise `https://wissen.example.org`, ohne Pfad. Der Node-Port bleibt auf `127.0.0.1` gebunden.

Bis zur ersten Anmeldung den Zugriff am Reverse-Proxy auf die Person beschränken, die den ersten Admin übernehmen soll. Die **erste gültige JWT-Anmeldung erhält die Adminrolle**, unabhängig von Rollen-Claims des Anbieters. Danach ist die Einrichtung dauerhaft geschlossen. Auch ein administratives Entfernen aller Benutzer in SQLite öffnet sie nicht erneut.

In der Anwendung anmelden, unter **Administration → KI & Modelle** den Gemini-Schlüssel speichern, beide Modelle auswählen und speichern. **Funktion testen** prüft eine echte kurze Textantwort und ein Embedding. Danach die erste Quelle hinzufügen. Sie wird im Chat berücksichtigt, sobald ihr Status **Bereit** lautet.

## JWT und externe Anmeldung

Es gibt bewusst keine lokalen Passwörter und keinen lokalen Token-Aussteller. Verwendet wird ein vom eigenen Identity Provider für diese Anwendung ausgestelltes JWT. Opaque Access Tokens werden nicht akzeptiert. Ein OIDC-Authorization-Code-Flow samt Refresh-Token-Verwaltung ist nicht Teil dieses generischen JWT-Verbrauchers; das bestehende Organisationsportal übernimmt Login und Token-Erneuerung.

Erforderliche Claims:

```json
{
  "iss": "https://identity.example.org/",
  "aud": "wissensraum",
  "sub": "stable-external-user-id",
  "email": "person@example.org",
  "name": "Erika Beispiel",
  "iat": 1789030800,
  "exp": 1789034400
}
```

Die Zeitstempel sind ausschließlich ein Formatbeispiel; für die Anmeldung aktuelle Zeiten verwenden. `exp` und `iat` sind Unix-Sekunden. `aud` darf auch ein Array mit der konfigurierten Audience sein. `iss` muss einschließlich eines etwaigen abschließenden Slash exakt passen. `nbf` wird geprüft, wenn vorhanden. Die Uhrtoleranz beträgt fünf Sekunden. Name und E-Mail müssen nichtleere Strings sein, die E-Mail muss ein gültiges einfaches Adressformat haben. Die stabile lokale Identität ergibt sich aus **`iss` + `sub`**, nicht aus der veränderlichen E-Mail-Adresse.

| Modus              | Konfiguration                                              | Zulässige Algorithmen                                        |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Öffentliche JWKS   | `JWT_MODE=jwks`, `JWT_JWKS_URL=https://…`                  | Genau der konfigurierte Algorithmus: RS256, ES256 oder EdDSA |
| Lokaler Public Key | `JWT_MODE=public_key`, `JWT_PUBLIC_KEY_FILE=/…/public.pem` | RS256, ES256 oder EdDSA; SPKI-PEM                            |
| Gemeinsames Secret | `JWT_MODE=secret`, `JWT_SECRET=…`, `JWT_ALGORITHM=HS256`   | Nur HS256; mindestens 32 Bytes                               |

JWKS-Schlüssel werden mit begrenztem Cache dynamisch nachgeladen; `kid` wird durch `jose` ausgewertet. Symmetrische und asymmetrische Verfahren können nicht versehentlich miteinander vermischt werden. Aussteller, Audience, Zeit und Signatur werden bei **jeder** geschützten Anfrage geprüft. Lokale Sperren und Rollenänderungen gelten für die nächste Anfrage sofort.

### Übergabe an die Oberfläche

1. Manuell: JWT im Anmeldeformular einsetzen. Das ist auch ein funktionaler Einstieg, solange die Portal-Anbindung noch vorbereitet wird.
2. Portal: Nach dem dortigen Login an `https://wissen.example.org/#access_token=URL_ENCODED_JWT` weiterleiten. Das Frontend entfernt das Fragment sofort aus der Adresszeile und tauscht den Token über `POST /api/auth/exchange` aus. **JWTs niemals als Query-Parameter übergeben.**
3. API-Client: `Authorization: Bearer <JWT>` senden. Die lokale Registrierung erfolgt zuvor über `POST /api/auth/exchange`.

`AUTH_LOGIN_URL` ergänzt im Anmeldebildschirm einen Link auf euer bestehendes HTTPS-Portal. Es ist kein automatisch eingerichteter OAuth-Endpunkt.

Für Browser speichert der Server das externe JWT AES-256-GCM-verschlüsselt in einem HttpOnly-Session-Cookie mit `SameSite=Strict`; in Produktion zusätzlich `Secure` und `__Host-`-Präfix. Es liegt weder im Local Storage noch im Session Storage. Der Server speichert keine Session-Tabelle. Bei Ablauf des JWTs muss das Portal einen neuen Token liefern. API-Tokens bis 16.000 Zeichen sind möglich; für die Cookie-Anmeldung muss der verschlüsselte Wert unter 3.800 Zeichen bleiben. Bei übergroßen Tokens unnötige Claims beim IdP entfernen.

## Konfiguration

| Variable                     | Bedeutung / Standard                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `production` verlangt eine HTTPS-Origin und setzt sichere Cookies                |
| `HOST`, `PORT`               | Standard `127.0.0.1`, `3000`; Update-Healthcheck verwendet Loopback              |
| `APP_ORIGIN`                 | Exakte Browser-Origin; ohne Pfad, Query oder Fragment                            |
| `TRUST_PROXY_HOPS`           | Standard 0, Beispiel 1 für genau einen lokalen Reverse-Proxy                     |
| `DATA_DIR`                   | Absoluter oder relativ zum Projekt aufgelöster Laufzeitordner; Standard `var`    |
| `APP_ENCRYPTION_KEY`         | Pflichtfeld: 32 zufällige Bytes, hexadezimal; schützt API-Schlüssel und Cookies  |
| `JWT_MODE`, `JWT_ALGORITHM`  | Vertrauensmodus und fest erlaubter Algorithmus                                   |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Pflichtfelder des Vertrauensmodells                                              |
| `JWT_JWKS_URL`               | HTTPS-JWKS-Adresse des vertrauenswürdigen Anbieters                              |
| `JWT_PUBLIC_KEY_FILE`        | Lokale Public-Key-Datei für `public_key`                                         |
| `JWT_SECRET`                 | Nur für HS256; nicht mit `APP_ENCRYPTION_KEY` wiederverwenden                    |
| `JWT_MAX_AGE_SECONDS`        | Maximales Alter seit `iat`, standardmäßig 86.400 Sekunden; `exp` gilt zusätzlich |
| `AUTH_LOGIN_URL`             | Optionaler Link zum Organisationsportal                                          |
| `UPLOAD_MAX_MB`              | 20, konfigurierbar von 1 bis 50; Reverse-Proxy-Limit entsprechend anpassen       |
| `CRAWL_MAX_PAGES`            | 40, konfigurierbar von 1 bis 100; Tiefe bleibt immer höchstens 2                 |
| `RAG_MIN_SCORE`              | Untere Kosinusähnlichkeit, standardmäßig 0,3; anhand eigener Quellen kalibrieren |
| `ALLOW_UPDATES`              | Standard `false`; nach Betriebs-Einrichtung explizit auf `true` setzen           |
| `UPDATE_REPOSITORY`          | Exakte öffentliche GitHub-HTTPS-Remote von `origin`                              |
| `UPDATE_BRANCH`              | Freigegebener Branch, standardmäßig `main`                                       |
| `PM2_APP_PREFIX`             | Standard `wissensraum`; erzeugt drei feste Prozessnamen                          |
| `CONFIG_FILE`                | Optionaler absoluter Pfad zu einer alternativen `.env`-Datei                     |

Gemini-Schlüssel und Modellwahl werden im Dashboard verwaltet und in SQLite gespeichert. Der Schlüssel ist dort verschlüsselt. JWT-Schlüssel und Update-Remote sind bewusst nur serverseitig konfigurierbar. Eine Änderung von Umgebungsvariablen wird mit `pm2 restart ecosystem.config.cjs --update-env` übernommen. Beim Wechsel des `PM2_APP_PREFIX` zuerst die bisherigen Prozesse gezielt stoppen und entfernen; keine doppelten Instanzen starten.

## Wissen und RAG

**Dateien:** bis 20 MB standardmäßig, PDFs bis 300 Seiten, Tabellen bis 50.000 Zeilen und 500 Spalten, extrahierter Text bis zwei Millionen Zeichen pro Quelle. Office-ZIPs werden vor dem Entpacken auf Größe, Kompressionsverhältnis, Anzahl der Einträge und Verschlüsselung geprüft. PDF-/Office-Ausleser laufen in kurzlebigen Node-Prozessen mit 256 MB V8-Heap und 90 Sekunden Zeitlimit. Diese Prozessgrenzen ersetzen keine OS-Sandbox; Dienstbenutzer und Rechnerrechte sollten entsprechend knapp sein.

Unterstützt werden die angegebenen modernen Office-Formate, keine alten `.doc`/`.xls`, PowerPoint-Dateien, Makroformate oder passwortgeschützten Dokumente. Scans benötigen vorab OCR. CSV unterstützt Komma, Semikolon und Tab; Textdateien UTF-8 oder UTF-16 mit BOM. Tabellenformeln werden nicht ausgeführt: gespeicherte Ergebnisse werden gelesen, fehlende Ergebnisse sichtbar markiert.

**Crawls:** Startseite = Tiefe 0, direkte Links = Tiefe 1, deren Links = Tiefe 2. Externe Domains einschließlich Subdomains und `www`-Varianten werden nicht verfolgt, auch nicht bei Redirects. Startadressen dürfen ausschließlich öffentlich auflösbare Domainnamen, HTTP(S) und Standardports verwenden. Maximal fünf Redirects, 20 Sekunden pro HTTP-Abruf, zwei MB pro Seite und 15 Minuten pro Crawl. IP-Literale, interne/reservierte IPs, URL-Zugangsdaten und DNS-Rebinding-Ziele werden abgewiesen. Jeder Socket nutzt eine zuvor geprüfte Adresse. robots.txt wird beachtet; eine nicht prüfbare robots.txt lässt den Crawl fehlschlagen. Maximal zulässige Crawl-Pause: 60 Sekunden.

Der Crawler liest serverseitig ausgeliefertes HTML und Text. Er führt kein JavaScript aus, meldet sich nicht auf Websites an und lädt keine verlinkten Dokumente herunter. Solche Dokumente direkt hochladen. Fehlende Unterseiten und erreichte Limits werden als Hinweise angezeigt; eine unlesbare Startseite lässt den Auftrag fehlschlagen.

**Indexierung:** Abschnitte mit etwa 1.800 Zeichen und 220 Zeichen Überlappung, sinnvoll an Wort-/Absatzgrenzen getrennt. Pro Quelle höchstens 1.600 Abschnitte. Embeddings werden in Paketen von 24 angefordert, auf 768 Dimensionen begrenzt, normalisiert und als Float32-BLOBs gespeichert. `gemini-embedding-001` verwendet getrennte Retrieval-Tasks für Dokumente und Fragen; Embedding 2 verwendet die dokumentierten Textpräfixe. Modell und Formatversion bilden ein gemeinsames Profil. Inkompatible Vektoren werden nie verglichen.

Das Chat-Modell wird über `models.list` ermittelt. Alle Seiten der Liste werden gelesen; `generateContent` ist Voraussetzung. Zusätzlich werden anhand ihrer Modellnamen Bild-, Audio-, Live- und andere spezialisierte Nicht-Chat-Modelle ausgeschlossen, weil die Modellliste nicht bei allen Modellen eine eindeutige Ausgabe-Modalität enthält. Die Auswahl wird serverseitig gegen die aktuelle Liste geprüft. Ein Modell wird nicht stillschweigend durch ein anderes ersetzt.

Ein Wechsel des Embedding-Modells ist möglich, sobald keine Jobs mehr laufen. Alle bereits lesbaren Quellen werden danach neu indexiert. **Neu indexieren** verwendet den gespeicherten Text; für geänderte Webseiten oder Dateien die aktuelle Fassung erneut hinzufügen und die frühere Quelle deaktivieren/löschen.

**Suche:** Exakte Kosinusähnlichkeit über passende aktive Vektoren in einem Worker-Thread; höchstens sieben Auszüge, maximal drei pro Quelle und 12.000 Kontextzeichen. Diese portable Lösung ist für kleine und mittlere Wissensbestände gedacht. Suchzeit wächst linear mit der Anzahl der Abschnitte. Bei sehr großen Beständen vorher mit realen Daten messen; ein SQLite-Vektorindex kann später hinter der bestehenden Retrieval-Schnittstelle ergänzt werden.

Dokumentanweisungen gelten für das Modell als nicht vertrauenswürdige Daten. Das Modell bekommt keine Werkzeuge für Datenbank-, Rollen- oder Systemänderungen. Seine Antwort soll auf belegbaren Quellen beruhen und fehlendes Wissen benennen. Quellenbelege erhöhen die Nachvollziehbarkeit, garantieren aber nicht die sachliche Fehlerfreiheit jeder Modellantwort.

## Daten und Gesprächskontext

| Daten                       | Ablage und Lebensdauer                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| Identität, lokale Rollen    | SQLite, bis administrativ entfernt; keine Rollen aus JWTs                                |
| Gemini-Schlüssel            | AES-GCM-verschlüsselt in SQLite                                                          |
| Wissen, Auszüge, Embeddings | SQLite, bis zur Quellenlöschung                                                          |
| Original-Uploads            | Geschützter Laufzeitordner, nach erfolgreicher Indexierung oder Quellenlöschung entfernt |
| Fehlgeschlagene Uploads     | Für erneute Indexierung aufbewahrt, bis die Quelle gelöscht wird                         |
| Chats                       | Nur React-Arbeitsspeicher und `sessionStorage`, nach lokaler Benutzer-ID getrennt        |
| Session-Token               | Verschlüsselter HttpOnly-Browser-Cookie; externe JWT-Prüfung pro Anfrage                 |
| Audit                       | Akteur-ID, Aktion, Ziel-ID, Zeit; keine Inhalte oder Secrets; Bereinigung nach 90 Tagen  |
| Erfolgreiche Jobs           | Metadaten für 30 Tage; Nutzdaten nach Abschluss geleert                                  |

Neue Gespräche und Abmelden löschen den entsprechenden Chat-Verlauf im Browser. Bei abgelaufener Anmeldung kann derselbe Benutzer nach erneuter Anmeldung seinen bestehenden Tab-Verlauf weiterverwenden. Browser-Sitzungswiederherstellung kann `sessionStorage` erhalten. Antworten mit Quellen und Fragen werden für jede Antwort an Gemini übergeben; der lokale Verzicht auf Chat-Tabellen ist keine Aussage über Googles Verarbeitung oder Aufbewahrung. Es wird kein serverseitiger Gemini-Chat angelegt.

Ältere Nachrichten werden niemals stillschweigend entfernt. Falls `countTokens` verfügbar ist, wird die Modellgrenze geprüft; andernfalls gilt eine konservative Zeichengrenze. Bei Überschreitung fordert die Oberfläche ein neues Gespräch bzw. ein größeres Modell. API-Grenzen: 2 MB JSON, höchstens 2.000 Nachrichten und 32.000 Zeichen pro Nachricht. Die Browser-Speichergrenze wird separat angezeigt, falls sie erreicht wird.

Pausieren/Löschen verhindert die zukünftige Verwendung als neues Retrieval-Ergebnis. Bereits angezeigte bzw. an Gemini übergebene Auszüge, historische Antworten und ältere Backups werden dadurch nicht rückwirkend entfernt. Quellen sind organisationsweit sichtbar; es gibt keine quellenspezifischen Zugriffskontrolllisten.

## Updates und Wiederherstellung

Voraussetzungen: sauberer Git-Checkout mit Lockfile, passendem HTTPS-`origin`, richtigem Branch und allen drei PM2-Prozessen unter demselben Dienstbenutzer. `node_modules`, `dist`, `.env` und Laufzeitdaten müssen ungetrackt/ignoriert bleiben. Automatische Updates funktionieren nicht bei einem bloß entpackten ZIP ohne eingerichtetes Git-Remote.

Nach Einrichtung `ALLOW_UPDATES=true` und die korrekte `UPDATE_REPOSITORY` setzen, dann:

```bash
pm2 restart ecosystem.config.cjs --update-env
pm2 save
```

Im Dashboard startet **Update starten** den folgenden Ablauf:

1. Unabhängiger Daemon übernimmt einen exklusiv angelegten Auftrag. Der selbständige Runner wird vor dem Git-Wechsel außerhalb des Checkouts abgelegt.
2. Checkout, Remote, Branch, Speicher und PM2-Instanzen prüfen; neuen Commit abrufen und Fast-Forward-Fähigkeit prüfen. Ohne neuen Commit endet der Lauf ohne Neustart.
3. Wartungsmodus setzen, Webserver/Indexer stoppen. Der Update-Daemon läuft weiter. SQLite per Backup-API sichern und Integrität prüfen; vorhandene Abhängigkeiten und Frontend sichern.
4. `git pull --ff-only origin <branch>`; auf genau den zuvor geprüften Commit begrenzen.
5. `npm install --include=dev --no-audit --no-fund`; unerwartete Änderungen an Manifest/Lockfile ablehnen. `npm run build` und `npm test` ausführen.
6. Migrationen anwenden; bestehende Migrationsdateien sind per SHA-256 geschützt. Neue Migrationen sind nummerierte SQL-Dateien und laufen in einer Transaktion.
7. Webserver und Worker per PM2 neu starten. Git-Revision, HTTP-Bereitschaft und frischen Worker-Heartbeat prüfen. Erst nach Erfolg wird der Wartungsmodus aufgehoben.

Schlägt ein Schritt nach dem Stoppen fehl, werden beide Prozesse erneut gestoppt, der vorherige Git-Commit wiederhergestellt und gegebenenfalls Datenbank, `node_modules` sowie `dist` aus dem Backup restauriert. Die Wiederherstellung benötigt **keinen npm-Download**. Anschließend wird auch der alte Stand auf Bereitschaft geprüft. Schlägt die Wiederherstellung fehl, bleibt der Wartungsmodus gesetzt; die Oberfläche zeigt nach Wiederverbindung den entsprechenden Status.

Journal, Backups und Status liegen unter `DATA_DIR/updates/runs/<UUID>/` bzw. `DATA_DIR/updates/status.json` und überleben das Datenbank-Rollback. Ein erkannter unterbrochener Lauf wird beim nächsten Daemon-Start anhand seines ursprünglichen Journals zurückgerollt. `flock` verhindert, dass eine Wiederherstellung noch laufende, verwaiste Installationsbefehle überholt. Ein Systemabsturz kann trotzdem manuelle Kontrolle erfordern, insbesondere bei defektem Datenträger oder fehlendem freien Speicher.

Der Daemon behält die fünf neuesten abgeschlossenen Läufe samt Backups. Läufe mit fehlgeschlagenem Rollback werden nie automatisch gelöscht. Diese lokalen Update-Backups ersetzen keine separate Sicherung des Servers. Nach unterbrochenen Uploads verwaiste Originaldateien werden frühestens nach 24 Stunden entfernt; zu einer bestehenden Quelle gehörende fehlgeschlagene Uploads bleiben für Wiederholungen erhalten.

**Update-Vertrauen:** Der freigegebene Branch enthält ausführbaren Anwendungscode und npm-Skripte. Schreibrechte auf dieses Repository sind damit faktisch Bereitstellungsrechte auf dem Dienstkonto. Branch-Schutz und geprüfte Änderungen gehören in den GitHub-Betrieb. Es wird weder ein beliebiges Repository noch ein beliebiger Shell-Befehl aus dem Browser übernommen.

### Manuelle Wiederherstellung eines fehlgeschlagenen Rollbacks

Als derselbe PM2-Dienstbenutzer zuerst die drei eigenen Prozesse stoppen. Anschließend den zum betroffenen Lauf gehörenden unveränderten Snapshot ausführen; UUID und Konfigurationspfad anpassen:

```bash
pm2 stop wissensraum-web wissensraum-worker wissensraum-updater
CONFIG_FILE=/opt/wissensraum/.env node /var/lib/wissensraum/updates/runs/UUID/runner.mjs /var/lib/wissensraum/updates/runs/UUID/config.json --recover
pm2 restart wissensraum-updater
pm2 save
```

Der Runner restauriert den vorherigen Stand und startet Webserver/Worker selbst. Bei weiterem Fehler Wartungsmarker und Backups erhalten; anhand von `journal.json`, `status.json` und den PM2-Logs die Ursache beheben. `runner.lock`/`daemon.lock` niemals entfernen, solange der darin genannte Prozess läuft. `--recover` ausschließlich für den betroffenen fehlgeschlagenen Lauf verwenden, nicht für ein bewusst bereits erfolgreich in Betrieb genommenes Update mit zwischenzeitlich neuen Daten.

### Manuelle Backups und Portabilität

```bash
npm run db:backup
```

Die SQLite-Backup-API erzeugt auch im WAL-Betrieb einen konsistenten Snapshot. Eine rohe Kopie nur der `.sqlite`-Datei während des Betriebs reicht nicht aus. Für einen Serverumzug alle drei Prozesse stoppen und den **vollständigen** Laufzeitordner einschließlich ausstehender Uploads sowie die Konfiguration separat übertragen. Mit derselben Node-Hauptversion Abhängigkeiten neu installieren und auf dem Ziel `npm run db:migrate`/Build/PM2-Start ausführen. Den Verschlüsselungsschlüssel unverändert übernehmen.

## Lokale Entwicklung

Für lokale Tests eine echte, zum Entwicklungs-IdP passende JWT-Konfiguration verwenden. `NODE_ENV=development`, `APP_ORIGIN=http://localhost:5173`, `TRUST_PROXY_HOPS=0` und `DATA_DIR=./var` setzen. Browser exakt unter dieser Origin öffnen. In drei Terminals:

```bash
npm run dev
npm run worker
npm run dev:web
```

Vite leitet `/api` zum Backend auf Port 3000 weiter. Für einen lokalen Test des gebauten Frontends stattdessen `APP_ORIGIN=http://localhost:3000` setzen, `npm run build` und `npm start` ausführen. Test-Tokens werden nur in automatisierten Tests erzeugt; es gibt keinen produktiven Login-Bypass.

## API-Übersicht

Alle Mutationen aus dem Browser benötigen gleiche Origin und `X-CSRF-Guard: 1`. API-Clients können stattdessen den Bearer-Header nutzen. JSON-Anfragen verwenden `Content-Type: application/json`.

| Methode / Pfad                                      | Zugriff                        | Zweck                                      |
| --------------------------------------------------- | ------------------------------ | ------------------------------------------ |
| `GET /api/health`                                   | Öffentlich                     | Betriebsstatus, Revision, Worker-Heartbeat |
| `GET /api/bootstrap`                                | Öffentlich                     | Setupstatus und konfigurierter Portal-Link |
| `POST /api/auth/exchange`                           | Gültiger externer Bearer-Token | Lokale Registrierung und Browser-Cookie    |
| `POST /api/auth/logout`                             | Browser-CSRF-Schutz            | Cookie löschen                             |
| `GET /api/me`, `GET /api/overview`                  | Alle Rollen                    | Identität und Verfügbarkeit                |
| `POST /api/chat`                                    | Alle Rollen                    | SSE-Stream; Body `messages: [{role: "user" | "model", text: "…"}]` |
| `GET /api/sources`                                  | Editor/Admin                   | Suche `q`, Pagination `page`               |
| `POST /api/sources/text`                            | Editor/Admin                   | `{title,text}`                             |
| `POST /api/sources/url`                             | Editor/Admin                   | `{title?,url}`                             |
| `POST /api/sources/upload`                          | Editor/Admin                   | Multipart mit `file` und optional `title`  |
| `PATCH /api/sources/:id`                            | Editor/Admin                   | `{active: true                             | false}`               |
| `POST /api/sources/:id/reindex`                     | Editor/Admin                   | Gespeicherten Text erneut indexieren       |
| `DELETE /api/sources/:id`                           | Editor/Admin                   | Quelle und abhängige Daten löschen         |
| `GET /api/admin/settings`, `GET /api/admin/models`  | Admin                          | Einstellungen und aktuelle Modelle         |
| `PUT /api/admin/key`                                | Admin                          | `{apiKey}`                                 |
| `PUT /api/admin/models`                             | Admin                          | `{chatModel,embeddingModel}`               |
| `POST /api/admin/test`                              | Admin                          | Funktionstest der gewählten Modelle        |
| `GET /api/admin/users`                              | Admin                          | Benutzerliste mit `q` und `page`           |
| `PATCH /api/admin/users/:id`                        | Admin                          | `{role,enabled}`                           |
| `GET /api/admin/updates`, `POST /api/admin/updates` | Admin                          | Update-Status und Start                    |

Chat-SSE-Ereignisse: `sources`, `delta`, `warning`, `done`, `error`; bei Lernbefehlen `learned`. Antworten werden erst nach `done` in den Browser-Verlauf übernommen. Ein Abbruch stellt die Frage wieder in das Eingabefeld. Fehler folgen ansonsten `{error: {code,message,requestId}}`; sensible Fehlermeldungen des Anbieters und Stacktraces werden nicht an Clients ausgegeben.

## Prüfung und Grenzen der Abnahme

Der mitgelieferte [Prüfbericht](VERIFICATION.md) dokumentiert ausgeführte Prüfungen und offene Schritte für den Zielserver.

```bash
npm ci --include=dev --no-audit --no-fund
npm run check
npm test
npm run build
```

Die automatisierten Tests prüfen JWT-Sicherheit, First-Admin-Rennen, lokale Berechtigungen, CSRF, Schlüsselverschlüsselung, sämtliche Dateiformate, Crawl-Grenzen/SSRF, die echte Indexierungs- und Retrieval-Pipeline, vollständigen Gesprächskontext und Migrationstransaktionen. Update-Tests verwenden echte temporäre Git-Repositories und SQLite-Dateien; PM2- und npm-Fehler werden kontrolliert simuliert, einschließlich Fehlern bei Installation, Build, Migration, Neustart und Bereitschaftsprüfung.

Die CI benötigt weder Gemini-Schlüssel noch einen externen Identity Provider. Für die endgültige Inbetriebnahme müssen zusätzlich euer echtes JWT, euer Gemini-Projekt samt Kontingenten, der HTTPS-Proxy und ein Update aus eurem tatsächlichen GitHub-Repository geprüft werden. Ein öffentlicher GitHub-Upload oder Zugriff auf einen bestimmten Linux-Server wird durch das Quellcodepaket allein nicht ausgeführt.

Nach dem Build prüft `npm run test:smoke` die drei echten Node-Prozesse, HTTP-Auslieferung, eine lokal signierte JWT-Anmeldung sowie Neustart und SQLite-Persistenz. `npm run test:pm2` prüft denselben Ablauf zusätzlich über PM2. Beide verwenden eigene temporäre Daten, zufällige Testschlüssel und einen freien lokalen Port; der PM2-Test erhält ein isoliertes `PM2_HOME`. Bestehende Anwendungsdaten und PM2-Prozesse werden dabei nicht verwendet. Der PM2-Test muss auf einem Linux-System mit erlaubten lokalen Unix-Sockets ausgeführt werden.

## Offizielle Schnittstellenreferenzen

- [Gemini: Modelle auflisten und Fähigkeiten prüfen](https://ai.google.dev/api/models)
- [Gemini: Embeddings, Aufgabenformate und Modellwechsel](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini: Kontextgröße zählen](https://ai.google.dev/api/tokens)
- [PM2: Ecosystem-Konfiguration und Startparameter](https://pm2.keymetrics.io/docs/usage/application-declaration/)

Lizenz des Anwendungscodes: MIT. Bibliotheken unterliegen ihren jeweiligen Lizenzen.
