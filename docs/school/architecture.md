# Architektur

Das Diagramm [architecture.puml](architecture.puml) zeigt die Anwendung auf
Komponentenebene. Die Angular-Oberfläche ist in TypeScript implementiert und
kommuniziert über HTTP und JSON mit der ASP.NET-Core-API in C#.
Das Backend greift mit EF Core und dem Npgsql-Provider auf PostgreSQL zu.

Der separate Bereich **Serververlauf** liest gespeicherte Messungen mit
`GET /api/measurements`. Zeitraum und Cursor begrenzen die Abfrage. Die Ergebnisse
bleiben im Arbeitsspeicher der Oberfläche und werden nicht in die lokale Historie
übernommen. Empfangene gültige Browser-`LIVE_SAMPLE` werden lokal als `sensor`
mit ausstehendem Synchronisierungsstatus gespeichert und automatisch über
`POST /api/measurements/batch` an die C# API übertragen. EF Core und Npgsql
speichern sie in PostgreSQL. Bei einem API-Ausfall bleiben die Daten ausstehend;
erneute Übertragungen verwenden dieselben IDs und Daten.

IndexedDB ist der lokale Speicher des Clients für die lokale Historie und ihren
Synchronisierungsstand. PostgreSQL ist die serverseitige Datenbank. Beide sind
getrennte Speicher; es gibt keine direkte Datenbank-zu-Datenbank-Verbindung.
Die Übertragung erfolgt ausdrücklich durch den Client über die HTTP API.

Die Browser-Anwendung verbindet sich über Web Bluetooth mit
dem ESP32. Gültige `LIVE_SAMPLE`-Nachrichten liefern den aktuellen CO₂-Wert für
die Anzeige und werden über den beschriebenen Speicher- und Übertragungspfad
gesichert. `MeasuredAt` ist die Zeit des Empfangs im Browser, nicht Sensor-UTC
oder Sensor-Uptime. Ohne Verbindung verpasste Messungen werden nicht
wiederhergestellt; ein Journaldownload oder eine Lückennachlieferung findet
im Browser nicht statt. Android ist von dieser Änderung nicht betroffen.
