# Prüfbericht — Wissensraum 1.0.0

Prüfdatum: 10. September 2026. Umgebung: Linux, Node.js 24.19.0, npm 11.9.0.

| Prüfung                                                                 | Ergebnis                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| JavaScript-Syntax (`npm run check`)                                     | Erfolgreich                                                                                    |
| Frontend-Produktionsbuild (`npm run build`)                             | Erfolgreich; JavaScript ca. 342 KB, gzip ca. 109 KB                                            |
| Automatisierte Tests                                                    | 30 von 30 erfolgreich                                                                          |
| Aktueller npm-Abhängigkeitscheck, einschließlich Entwicklungswerkzeugen | 0 gemeldete bekannte Schwachstellen                                                            |
| Echte Anwendungsprozesse (`npm run test:smoke`)                         | Webserver, Indexierungsworker und Update-Daemon erfolgreich gestartet                          |
| HTTP und Anmeldung im Betriebstest                                      | Gebautes Frontend erreichbar; gültiges Test-JWT erzeugt ersten lokalen Admin                   |
| Neustart im Betriebstest                                                | Webserver und Worker neu gestartet; lokale Identität und Adminrolle erhalten                   |
| Echter PM2-Daemon                                                       | Hier nicht abgenommen: Unix-Socket-Verbindungen durch Ausführungsumgebung mit `EPERM` gesperrt |

Die 30 Tests decken ungültige und abgelaufene JWTs, RSA-Signaturen und Algorithmusverwechslungen, atomare First-Admin-Vergabe, ausschließlich lokale Rollen, Schutz des letzten Admins, CSRF, verschlüsselte API-Schlüssel und Upload-Berechtigungen ab. TXT, Markdown, CSV, DOCX, XLSX und PDF werden mit echten Dateien in separaten Prozessen gelesen. Weitere Tests prüfen ZIP-Entpackgrenzen, Crawl-Tiefe und Domain-Grenzen, SSRF-Abwehr, Indexierung mit echten SQLite-Vektoren, deaktivierte und gelöschte Quellen, Job-Leases, Modell-Paginierung, Modellwechsel, Gesprächskontext, SSE-Decodierung und Migrationstransaktionen.

Update-Tests arbeiten mit echten temporären Git-Repositories und SQLite-Dateien. Installation, Build, Migration, Neustart und Bereitschaftsprüfung werden jeweils gezielt zum Scheitern gebracht. Anschließend werden wiederhergestellte Git-Stände, Datenbankinhalte, Abhängigkeiten und Frontend-Dateien geprüft. Erfolgreiche Updates, verschmutzte Checkouts und Wiederaufnahme nach einem Runner-Absturz sind ebenfalls abgedeckt. npm- und PM2-Kommandos innerhalb dieser Update-Tests werden kontrolliert simuliert; sie ersetzen keinen Update-Lauf auf dem Zielserver.

## Abnahme auf dem Zielserver

Nach `npm ci --include=dev` und `npm run build` steht mit `npm run test:pm2` ein zusätzlicher Betriebstest bereit. Er verwendet drei echte PM2-Prozesse in einer eigenen temporären PM2-Instanz, eine eigene SQLite-Datei und zufällige Testschlüssel. Bestehende Dienste werden nicht verwendet.

Für die Inbetriebnahme fehlen noch die Prüfung mit dem tatsächlichen Identity Provider, dem tatsächlichen Gemini-Projekt, dem HTTPS-Reverse-Proxy und dem vorgesehenen GitHub-Repository. Gemini-Antworten und Embeddings in den automatisierten Tests stammen aus kontrollierten API-Fixtures; es wurden keine echten Gemini-Abfragen ausgeführt. Die Oberfläche wurde gebaut und per HTTP geprüft; eine visuelle Browser-Abnahme ist nicht Teil dieses Berichts.

Das Paket wurde weder in ein öffentliches GitHub-Repository hochgeladen noch auf einem Zielserver installiert. Die Einrichtungsschritte, JWT-Claims und Konfiguration stehen in `README.md` und `.env.example`. Ein npm-Audit ist eine zeitabhängige Prüfung bekannter Meldungen und kein Nachweis vollständiger Fehlerfreiheit.
