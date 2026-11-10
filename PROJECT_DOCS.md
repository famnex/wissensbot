# Projektdokumentation: Wissensraum (PROJECT_DOCS.md)

Dieses Dokument beschreibt die Architektur, Datenflüsse, Systemkomponenten und die lokale Ausführung des Projekts **Wissensraum**.

---

## 1. Übersicht & Zielsetzung

Wissensraum ist eine selbst gehostete Wissens- und Chat-Anwendung mit Retrieval-Augmented Generation (RAG):
- **KI-Anbindung:** Google Gemini REST-API (ohne schwergewichtige Drittanbieter-SDKs).
- **RAG-Wissensbasis:** Dokumente (PDF, DOCX, XLSX, CSV, TXT, MD), Crawling von Webseiten und Freitext / `!learn`.
- **Identität & Sicherheit:** Externe JWT-Validierung (`jose`), rein lokale Rollenverwaltung (`admin`, `editor`, `user`), AES-256-GCM geschützte Cookies und API-Schlüssel, SSRF- und ReDoS-Schutz.
- **Transaktionale Persistenz:** SQLite mit `better-sqlite3` im WAL-Modus (kein externer Datenbankserver oder Vektordatenbank erforderlich).
- **Frontend:** React 19 SPA mit Vite, voll responsivem Layout und Markdown-Rendering mit Originalbeleg-Auszügen.

---

## 2. Kernkomponenten & Verzeichnisstruktur

| Pfad | Komponente | Beschreibung |
|---|---|---|
| `server/index.mjs` | **Webserver** | Haupt-Einstiegspunkt für den Express-Server (Port 3000). Liefert die REST-API sowie das gebaute React-Frontend (`dist/`) aus. |
| `server/app.mjs` | **Express-App** | API-Routen, Security-Header (Helmet CSP), Session- und Origin-Prüfungen, Fehlerbehandlung. |
| `server/auth.mjs` | **Authentifizierung** | JWT-Prüfung (`RS256`, `ES256`, `EdDSA` oder `HS256`), AES-Cookie-Verschlüsselung, Registrierung des ersten Admins. |
| `server/db/` | **Datenbank** | Verbindungsaufbau, automatische Migrationen mit SHA-256-Integritätsprüfung, Audit & Settings. |
| `server/services/gemini.mjs` | **Gemini-Service** | Direkte REST-Kommunikation mit Google Generative AI (Chat-Streaming, Embedding-Generierung, Token-Zählung). |
| `server/services/retrieval.mjs` | **Retrieval & RAG** | Vektorähnlichkeitssuche (Kosinusähnlichkeit in Float32-BLOBs) in einem dedizierten Worker-Thread (`retrieval-worker.mjs`). |
| `server/services/index-job.mjs` | **Indexierung** | Aufbereitung, Bereinigung, Chunking (~1800 Zeichen) und Batch-Vektorisierung von Wissensquellen. |
| `server/services/crawler.mjs` | **Web-Crawler** | Same-Origin-Crawler (Tiefe 0-2) mit robots.txt-Beachtung, DNS-Rebinding- und SSRF-Schutz. |
| `server/workers/indexer.mjs` | **Hintergrund-Worker** | Persistente Job-Warteschlange für Datei-Extraktion und Vektorisierung. Sendet periodisch Heartbeats. |
| `server/workers/extract-file.mjs`| **Dateiextraktion** | Isolierter Prozess mit begrenztem V8-Heap für PDF, Office und Tabellen. |
| `web/` | **Frontend** | React 19 Oberfläche (Chat, Administration, Wissensverwaltung, Login). |
| `scripts/` | **Hilfsskripte** | Migrationen, Backups, Syntax-Checks, Test-Token-Generator und lokaler Dev-Runner. |
| `tests/` | **Testsuite** | Node.js Test-Runner-Tests (`node --test`) mit In-Memory Mock-Servern. |

---

## 3. Datenfluss & Arbeitsweise

### A. Anmeldung & Sitzungen
1. Der Benutzer meldet sich per Single Sign-On (z. B. via **cloud.mso-hef.de** über den Button *„Zum Organisationslogin“* oder per SSO-Redirect mit `?sso_token=...`) an. Wenn ein SSO-Dienst konfiguriert ist, wird das Tokenfeld auf dem Login-Bildschirm vollständig ausgeblendet.
2. `POST /api/auth/exchange` validiert das externe Token:
   - Zuerst gegen die im **Adminbereich** konfigurierte SSO-Integration (verschlüsselter Shared Secret, flexible Claim-Zuordnung für `username`, `display_name`, `email`).
   - Alternativ gegen die Server-Konfiguration (`.env`: `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_SECRET` oder JWKS).
3. Der erste jemals validierte Benutzer wird automatisch und atomar zum **Admin**.
4. **Dauerhafte Anmeldung (Persistent Session):** Nach erfolgreicher Validierung erzeugt der Server ein versiegeltes Sitzungstoken mit 1 Jahr Gültigkeit (`maxAge: 365 Tage`). Bei Folgeanfragen prüft der Server direkt den aktiven Status des Benutzers in SQLite (`enabled = 1`), ohne dass kurze IdP-Token-Ablaufzeiten den Benutzer vorzeitig abmelden. Deaktivierungen im Adminbereich greifen dennoch sofort.
5. Ein AES-256-GCM verschlüsseltes HttpOnly-Session-Cookie (`__Host-` in Produktion) wird für den Browser gesetzt. Es gibt keine serverseitige Sitzungstabelle.

### B. Wissensverarbeitung & Dateianhänge (Ingestion Pipeline)
1. **Quelle anlegen:** Ein Editor oder Admin lädt eine Datei hoch, gibt eine URL oder Freitext ein (`POST /api/sources/*`).
2. **Job einreihen:** Ein Datensatz wird in `sources` mit Status `queued` angelegt; zeitgleich wird ein Job in `jobs` erzeugt.
3. **Worker übernimmt:** Der `indexer.mjs`-Prozess holt den Job per atomarem Leasing (`claimJob`), aktualisiert die Fortschrittsanzeige (`jobs.stage`, `jobs.progress`) und führt die Extraktion aus:
   - PDFs werden über `pdfjs-dist` extrahiert.
   - Word (`.docx`) über `mammoth`.
   - Excel (`.xlsx`) über `exceljs` (Werte werden ausgelesen, Formeln markiert).
   - CSV über `csv-parse`.
   - URLs über den gesicherten Crawler mit robots.txt-Parsing.
4. **Chunking, Titel & Embeddings:** Der extrahierte Text wird in Blöcke von ~1.800 Zeichen mit 220 Zeichen Überlappung zerlegt. Jeder Chunk erhält automatisch einen abgeleiteten Titel (`deriveChunkTitle`). Gemini erzeugt die Embeddings (Batch-Größe 24), welche normalisiert als 768-Dim Float32 BLOBs in der Tabelle `chunks` gespeichert werden.
5. **Abschluss & Feingranulare Bearbeitung:** Die Quelle wird auf `ready` gesetzt. Die erzeugten Wissensabschnitte können in der UI aufgeklappt, im Detail eingesehen, angepasst, gelöscht oder manuell ergänzt werden.
6. **Dateianhänge & Bilder an Wissensartikeln:**
   - Direkt im Editor eines Wissensartikels (`EditChunkModal`) können Bilder (Screenshots, Diagramme, Schemata) sowie Dokumente (PDFs, Handbücher) hochgeladen werden (`POST /api/chunks/:chunkId/attachments`).
   - Ein Klick auf *„In Text einfügen“* bettet das Bild oder den Download-Link direkt in den Markdown-Text des Artikels ein.
   - Beim Löschen eines Artikels oder einer Quelle werden alle physischen Dateien im Verzeichnis `var/attachments/` sauber bereinigt.

### C. Chat, Bildanzeige & Beantwortung
1. Der Benutzer sendet eine Nachricht im Chat (`POST /api/chat`).
2. Die Benutzerfrage wird vektorisiert.
3. Der `Retriever` ermittelt per Kosinus-Distanz im Worker-Thread die relevantesten Chunks (Score >= `RAG_MIN_SCORE`).
4. **Anhänge im RAG-Kontext:** Alle an den gefundenen Chunks hinterlegten Bilder und Dateien werden ausgelesen und an Gemini übergeben.
5. **Bot-Instruktionen:** Gemini wird angewiesen, passende Bilder direkt per Markdown (`![Name](URL)`) einzubetten und Dokumente als Download-Links anzubieten.
6. **Frontend-Rendering:**
   - Markdown rendert Bilder sicher mit Sanitizing (`loading="lazy"`, responsive Bildskalierung).
   - Unter der Bot-Antwort rendert Wissensraum interaktive Medien- und Download-Karten (`.attachment-card`) inklusive Dateigröße, Vorschaubild und 1-Klick-Download.
   - In den Quellennachweisen (`ARTIKEL & QUELLEN`) werden beigefügte Dateien als Pill-Badges angezeigt.
7. Die Antwort wird via Server-Sent Events (SSE) an das Frontend gestreamt (`delta`, `sources`, `done`).
8. Der Gesprächsverlauf bleibt lokal im Client (`sessionStorage`) und wird bei jeder Anfrage mitgeführt (keine serverseitige Speicherung von Chat-Nachrichten).

---

## 4. Wissensartikel & KI-gestützte Chunk-Verarbeitung

Wissensraum bricht Quellen in verständliche, durchsuchbare Wissensbausteine herunter – in der Anwendung einheitlich als **Wissensartikel** (oder kurz **Artikel**) bezeichnet:
- **Zähler nach Wissensartikeln:** Sämtliche Übersichten und Kennzahlen (Sidebar-Widget, Chat-Header, Wissensbasis-Statistiken) weisen primär die Anzahl der **verfügbaren Wissensartikel** aus statt nur die Dateianzahl.
- **Präzise Quellennennung im Chat:** Statt bei mehreren Belegen immer denselben Dateinamen (z. B. `ost_faq.sql`) anzuzeigen, blendet der Chat im Zitat-Aufklapper direkt den konkreten **Titel des Wissensartikels** (z. B. `[1] Aufsicht bei Klausuren und Arbeiten`) ein, ergänzt um Herkunftsdatei und Fundstelle.
- **Dateiformate & SQL-Dumps:** Unterstützung für PDF, Word (`.docx`), Excel (`.xlsx`), CSV, Text, Markdown, `.sql` und `.json`.
- **Semantische KI-Extraktion (`aiExtractKnowledgeChunks`):** Für strukturierte Dateien, FAQ-Dumps oder SQL-Exporte extrahiert Gemini direkt die semantischen Informationseinheiten als eigenständige Artikel mit treffenden Titeln und bereinigtem Reintext (HTML-Tags und SQL-Syntax werden entfernt).
- **Intelligente Vorfilterung (`extractSqlDocuments`):** Bei SQL-Dateien und Datenbank-Dumps werden Versions- und Steuerkommentare (`/*!40101 ...*/`, `SET SQL_MODE`, phpMyAdmin-Header) automatisch bereinigt. Tabellendefinitionen (`CREATE TABLE`) und zugehörige Datensätze (`INSERT INTO`) werden in zusammenhängende Einheiten mit konkreter Fundstelle (`Tabelle: <name>`) segmentiert.
- **KI-Analyse & Strukturierung via Gemini (`aiAnalyzeAndStructureChunks`):** Während des Indexierungsauftrags analysiert Gemini die Abschnitte vor der Vektorisierung. Die KI vergibt präzise, fachliche Titel (z. B. *„Tabelle kunden: Stammdaten & Ansprechpartner“*) und bereinigt technisches Rauschen oder Dump-Syntax zu klar strukturiertem Fachwissen.
- **Sicherer Heuristik-Fallback:** Ist temporär kein Gemini-Key hinterlegt, greift `deriveChunkTitle`, das Tabellennamen, SQL-Kommentare und Überschriften erkennt, sodass niemals „Ohne Titel“ entsteht.
- **Wissens-Drawer im Dashboard:** In der Wissensverwaltung kann jede Quelle über den Artikel-Button ausgeklappt werden. Ein Drawer zeigt alle abgeleiteten Artikel mit Nummer, Titel, Fundstelle/Location, Vorschau und Zeichenanzahl.
- **Vollansicht & Anpassung (Inline/Modal):** Über „Einsehen & anpassen“ kann der Titel, die Fundstelle und der vollständige Wissenstext korrigiert und ergänzt werden.
- **Automatische Neu-Vektorisierung:** Wird ein Wissensartikel gespeichert, berechnet das Backend automatisch ein neues Gemini-Embedding und aktualisiert den Vektor-Index, sodass die KI Korrekturen sofort in Chat-Antworten berücksichtigt.
- **Manuelle Artikel & Löschen:** Neue Wissensartikel können einer Quelle direkt hinzugefügt oder fehlerhafte Artikel dauerhaft entfernt werden. Der Zähler `chunk_count` wird dabei atomar synchronisiert.
- **Quellen umbenennen:** Quellen können direkt in der Liste über das Stift-Symbol umbenannt werden (`PATCH /api/sources/:id` mit `{ title }`). Der neue Name spiegelt sich sofort in Chat-Zitaten und der Wissensverwaltung wider.
- **Export & Import zwischen Wissensräumen:** 
  - Jede Quelle kann einzeln als portable JSON-Datei exportiert werden (`GET /api/sources/:id/export`).
  - Über den Button „Alle exportieren“ kann die gesamte Wissensbasis gesichert werden (`GET /api/sources/export`).
  - Exportierte Dateien enthalten die vollständigen Quellmetadaten, Dokumente und alle abgeleiteten/korrigierten Wissensartikel.
  - Über „Quellen importieren“ (`POST /api/sources/import`) können diese in einen anderen Wissensraum übertragen werden; dort werden die Artikel direkt angelegt und automatisch mit den Modellen des Ziel-Wissensraums vektorisiert.
- **Verlinkung von Web-Quellen:** Ist eine Quelle eine URL (oder verweist auf eine Webseite), wird sie überall verlinkt:
  - In der Quellenliste als anklickbarer Titel und Link mit Globus-Icon.
  - Im Wissens-Drawer im Untertitel sowie an den abgeleiteten Wissensartikeln.
  - In Chat-Zitaten als anklickbarer Link mit „Webseite öffnen“.

---

## 5. Wissens-Inbox für unbeantwortete Fragen & Wissenslücken

Wenn Nutzer im Chat Fragen stellen, zu denen noch kein passendes Wissen in der Wissensbasis existiert, erfasst Wissensraum diese Wissenslücken vollautomatisch:
- **Automatische Erkennung im Chat:**
  - *Strikte Wissenslücke:* Findet die Vektorsuche keine relevanten Quellen (0 Chunks), wird die Frage unmittelbar erfasst.
  - *Semantische Wissenslücke:* Auch wenn Randinformationen gefunden werden, Gemini aber erkennt, dass die entscheidende Information fehlt, signalisiert der Chat dies und hängt das Systemtag `[WISSENSLUECKE]` an (wird vor der Anzeige im Client bereinigt).
- **Nutzer-Transparenz & Verlässlichkeit:**
  - Der Chat informiert den Nutzer höflich, dass dazu aktuell noch kein Wissen vorliegt, die Frage jedoch in der **Wissens-Inbox** für die Redaktion vermerkt wurde und nachgepflegt wird.
  - An der Antwort wird ein auffälliger Hinweis-Banner (*„In Wissens-Inbox vermerkt“*) eingeblendet.
- **Deduplizierung & Häufigkeitszähler (`count`):**
  - Wird dieselbe Frage mehrfach von verschiedenen Nutzern gestellt, während sie offen ist, legt das System keinen Duplikat-Eintrag an, sondern erhöht den Zähler atomar (`count = count + 1`), aktualisiert den Zeitstempel und die letzte KI-Antwort.
  - In der Inbox werden häufig nachgefragte Themen mit einem Flammen-Badge hervorgehoben (z. B. `🔥 3x gefragt`).
- **Wissens-Inbox im Hauptmenü:**
  - Für Redakteure und Administratoren erreichbar über den Menüpunkt **Wissens-Inbox** in der Navigation.
  - Ein rotes Status-Badge (`.nav-count-alert`) zeigt sofort an, wie viele unbeantwortete Fragen noch offen sind.
- **Workflow & 1-Klick-Wissensanlage:**
  - **Status-Filter:** Filterung nach *Offen*, *Erledigt*, *Verworfen* oder *Alle*.
  - **Suche:** Durchsuchung von Fragen und Fragestellern in Echtzeit.
  - **Bisherige KI-Antwort:** Kann zur Orientierung aufgeklappt werden.
  - **„Wissen anlegen“-Aktion:** Mit einem Klick öffnet sich der Dialog „Wissen hinzufügen“ mit vorausgefülltem Titel und Themenfeld, sodass Redakteure die Lücke ohne Medienbruch sofort schließen können.
  - **Statusverwaltung & Notizen:** Fragen können als *Erledigt* oder *Verworfen* markiert werden, interne Bearbeitungsnotizen können hinterlegt werden.

---

## 7. Updates & Wartungsdienst (PM2 Update-Runner)

- **Update-Workflow:**
  - Der PM2-Dienst `wissensraum-updater` überwacht `var/updates/request.json`.
  - Bei Anforderung über den Adminbereich führt er atomare Backups (Git SHA, Datenbank, Node Modules, Dist) durch, zieht den Ziel-Branch per `git fetch`/`git checkout`, migriert die Datenbank, baut das Frontend und startet die PM2-Dienste neu.
  - Im Fehlerfall erfolgt ein automatisches Rollback auf den vorherigen Stand.
- **Fehlerbehandlung & Reset:**
  - `DELETE /api/admin/updates` setzt blockierte oder fehlgeschlagene Update-Zustände (`status.json`, `request.json`, `command.lock`) sauber auf `idle` zurück.
  - Im Adminbereich steht bei Fehlern die Schaltfläche *„Meldung zurücksetzen“* bereit.
- **SSO Identity Provider Integration (Novus / Nextcloud):**
  - Vollständige SSO-Unterstützung für z. B. `cloud.mso-hef.de` (JWT Redirect).
  - Ziel-URL in der IdP-Kachel: `https://<domain>/wissen/`
  - URL Query Parameter: `sso_token` (Standard)
  - Claims: `username`, `display_name`, `email`
  - Geteilter Signierschlüssel (Secret) wird im Adminbereich unter *Einstellungen -> SSO Identity Provider* hinterlegt.

---

## 8. Lokale Ausführung unter Windows

### Start per `start.bat`
- Ein Doppelklick auf `start.bat` erledigt die komplette Initialisierung:
  1. Prüfung der Umgebung (Node.js >= 22).
  2. Installation der Pakete (`npm install`).
  3. Erstellung der `.env`-Konfigurationsdatei mit sicheren Schlüsseln.
  4. Ausführung der Datenbankmigration (`npm run db:migrate`).
  5. Bau des React-Frontends (`npm run build`).
  6. Generierung eines Admin-Testtokens inkl. 1-Klick-Login-Link.
  7. Start des Webservers und des Indexierungs-Workers.
  8. Automatisches Öffnen im Browser unter `http://127.0.0.1:3000`.

### Manuelle Befehle
```powershell
# Abhängigkeiten installieren
npm install

# Datenbank migrieren
npm run db:migrate

# Frontend bauen
npm run build

# Webserver & Worker gemeinsam starten
npm run serve

# Test-Token für den Login generieren
npm run token

# Automatische Tests ausführen
npm test
```
