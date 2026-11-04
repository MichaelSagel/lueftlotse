# Lüftlotse – L&G Projekt

Lüftlotse zeigt die aktuelle CO₂-Konzentration eines verbundenen Sensors und
stellt gespeicherte Messungen aus PostgreSQL in einem getrennten Serververlauf
dar. Empfangene gültige `LIVE_SAMPLE` werden im Browser lokal in IndexedDB
gespeichert und automatisch über die C# API nach PostgreSQL übertragen.

## Lernumfang

Das Projekt verbindet Angular und TypeScript im Browser mit einer HTTP-API auf
Basis von ASP.NET Core und C#. EF Core bildet die Messungen ab und greift über
den PostgreSQL-Provider auf PostgreSQL zu. Das Modell hat eine einzelne
Measurement-Entität. Die aktuelle Anzeige nutzt neue Sensorwerte; der
Serververlauf liest die bereits übertragenen Messungen getrennt über HTTP.
`MeasuredAt` ist beim Browserpfad die Zeit des Empfangs im Browser, nicht eine
vom Sensor ermittelte Messzeit. Ohne Verbindung verpasste Messungen werden
nicht nachträglich wiederhergestellt. Android ist von dieser Änderung nicht betroffen.

- [Domänenmodell](domain-model.md) und [UML-Diagramm](domain-model.puml)
- [Architektur](architecture.md) und [Architekturdiagramm](architecture.puml)
- [GUI-Vergleich mit Wireframe und Screenshot](gui-comparison.md)
- [Präsentationsnotizen](presentation-notes.md)

## Voraussetzungen und lokale Konfiguration

Benötigt werden das .NET SDK 10.0.402, Node.js und npm passend zur
Projektkonfiguration sowie eine laufende PostgreSQL-Instanz. Das Backend liest
seine Verbindungszeichenfolge unter `ConnectionStrings:Lueftlotse`; für die
lokale Entwicklung wird dieser Wert mit .NET User Secrets verwaltet. Zugangsdaten
gehören weder in Git noch in diese Dokumentation.

Für den Serververlauf muss die konfigurierte Datenbank erreichbar sein und die
EF-Core-Migration für die Tabelle `measurements` bereits angewendet worden sein.
Das Backend wendet Migrationen beim Start nicht automatisch an. Die Anwendung
der Migration auf eine lokale Datenbank ist ein separater Einrichtungsschritt.

## Erster Start

Die folgenden Befehle werden vom Stammverzeichnis des Repositorys ausgeführt.
Zuerst werden die durch `mobile/package-lock.json` festgelegten npm-Pakete und
die .NET-Abhängigkeiten wiederhergestellt:

```text
npm --prefix mobile ci
dotnet restore backend/Lueftlotse.slnx
```

PostgreSQL muss laufen; die in der Verbindungszeichenfolge genannten Datenbank
und Rolle müssen bereits angelegt sein. Hinterlege die lokale Verbindungszeichenfolge
als .NET User Secret. Ersetze die Beispielwerte durch die eigenen lokalen Angaben;
Passwörter gehören nicht in Projektdateien oder Git:

```text
dotnet user-secrets set "ConnectionStrings:Lueftlotse" "Host=localhost;Port=5432;Database=<Datenbankname>;Username=<Datenbankbenutzer>;Password=<lokales-Passwort>" --project backend/src/Lueftlotse.Api
```

Wende danach die vorhandene EF-Core-Migration auf diese Datenbank an:

```text
dotnet ef database update --project backend/src/Lueftlotse.Api
```

Im Repository ist kein lokales `dotnet-ef`-Tool-Manifest vorhanden. Daher ist
`dotnet ef` nicht über ein Repository-Manifest bereitgestellt oder versioniert;
eine Installationsanweisung ist hier nicht hinterlegt.

Eine neu angelegte Datenbank enthält zunächst keine Messungen. Für eine
Demonstration mit Zeilen im Serververlauf müssen bereits Daten in diese Datenbank
übertragen worden sein; die Migration selbst erzeugt keine Beispieldaten.

Für einen reproduzierbaren Datensatz enthält
[`demo-measurements.json`](demo-measurements.json) zehn ausdrücklich als
`simulator` markierte Schul-Demomessungen. Der folgende PowerShell-Aufruf sendet
die Datei an die bestehende Batch-API. Er ist optional und wird nicht automatisch
beim Start ausgeführt:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:5045/api/measurements/batch" -ContentType "application/json" -InFile "docs/school/demo-measurements.json"
```

Alle Messzeiten liegen am 15.01.2026 zwischen 10:00 und 10:09 UTC. In der
Zeitzone Europe/Berlin im **Serververlauf** den Zeitraum **15.01.2026 11:00** bis
**15.01.2026 11:10** einstellen. Das Ende ist exklusiv. Ein erneuter Aufruf mit
unveränderter Datei verwendet dieselben UUIDs und Daten; vorhandene identische
Einträge werden als Duplikate bestätigt und nicht erneut eingefügt.

## Starten

Vom Stammverzeichnis des Repositorys aus in zwei getrennten Terminals starten:

```text
dotnet run --project backend/src/Lueftlotse.Api
```

```text
npm --prefix mobile start
```

Das Angular-Entwicklungssetup stellt die Anwendung unter
`http://localhost:4200/` bereit und leitet `/api/**` an das Backend unter
`http://127.0.0.1:5045` weiter. Für Bluetooth im Browser muss Chrome Web Bluetooth
unterstützen; die Anwendung braucht dafür `localhost` oder HTTPS.

## Kurze Demonstration

1. Die Anwendung in Chrome unter `http://localhost:4200/` öffnen und
   **Sensor auswählen** anklicken. Im Chrome-Gerätedialog den Lüftlotse-Sensor
   auswählen. Nach Verbindung und einem neuen gültigen Messwert erscheint das
   aktuelle CO₂ in der Anzeige. Der empfangene Wert wird lokal als `sensor`
   gespeichert und automatisch an die Batch-API gesendet. Bei einem API-Ausfall
   bleibt er lokal ausstehend und wird später erneut gesendet.
2. Nach erfolgreicher Übertragung **Serververlauf** öffnen, einen Zeitraum um
   den aktuellen Empfangszeitpunkt einstellen und **Laden** anklicken.
   Die Tabelle zeigt die realen Sensormessungen aus PostgreSQL mit **Quelle=sensor**.
   Die Zeit entspricht dem Empfang im Browser (`MeasuredAt`).
3. Den Zeitraum ändern und erneut **Laden** wählen, um die Periodenfilterung zu
   zeigen. Weitere Ergebnisse lassen sich bei vorhandener Folgeseite mit
   **Weitere laden** abrufen.
4. Für die separate Duplikatprüfung die unveränderte `demo-measurements.json`
   erneut senden. Nach dem ersten erfolgreichen Import meldet die API
   `received=10`, `inserted=0`, `duplicates=10`. Diese Demodaten bleiben als
   `simulator` gekennzeichnet; sie sind keine realen Sensormessungen.

Ohne ESP32 bleibt die aktuelle CO₂-Anzeige leer beziehungsweise zeigt bei
fehlendem Sensor **Sensor nicht verfügbar**. Der Serververlauf ist davon
unabhängig: Wenn Backend, PostgreSQL und vorhandene Messdaten verfügbar sind,
kann er weiterhin gelesen und nach Zeitraum gefiltert werden.
