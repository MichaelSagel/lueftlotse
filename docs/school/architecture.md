# Architektur

Das Diagramm [architecture.puml](architecture.puml) zeigt die Anwendung auf
Komponentenebene. Die Angular-Oberfläche ist in TypeScript implementiert und
kommuniziert über HTTP und JSON mit der ASP.NET-Core-API in C#.
Das Backend greift mit EF Core und dem Npgsql-Provider auf PostgreSQL zu.

Der separate Bereich **Serververlauf** liest gespeicherte Messungen mit
`GET /api/measurements`. Zeitraum und Cursor begrenzen die Abfrage. Die Ergebnisse
bleiben im Arbeitsspeicher der Oberfläche und werden nicht in die lokale Historie
übernommen. `POST /api/measurements/batch` dient der manuellen Übertragung bereits
lokal gespeicherter Messungen zum Backend.

IndexedDB ist der lokale Speicher des Clients für die lokale Historie und ihren
Synchronisierungsstand. PostgreSQL ist die serverseitige Datenbank. Beide sind
getrennte Speicher; es gibt keine direkte Datenbank-zu-Datenbank-Verbindung.
Die Übertragung erfolgt ausdrücklich durch den Client über die HTTP API.

Unabhängig davon verbindet sich die Browser-Anwendung über Web Bluetooth mit
dem ESP32. Gültige `LIVE_SAMPLE`-Nachrichten liefern den aktuellen CO₂-Wert für
die Anzeige. Dieser Vorschaupfad speichert keine Messungen in IndexedDB und
sendet sie nicht an die HTTP API oder PostgreSQL. Die Architekturübersicht
zeigt keine internen Abläufe von Android oder der Firmware.
