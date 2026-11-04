# Domänenmodell

Das Diagramm [domain-model.puml](domain-model.puml) zeigt die einzige derzeit
im EF-Core-Modell registrierte Domänenentität: `Measurement`. Grundlage sind
[Measurement.cs](../../backend/src/Lueftlotse.Api/Features/Measurements/Measurement.cs)
und [MeasurementConfiguration.cs](../../backend/src/Lueftlotse.Api/Features/Measurements/MeasurementConfiguration.cs).

Eine Messung enthält ihre Identität (`MeasurementId`), eine Gerätekennung
(`DeviceId`), die Herkunft (`Source`), den Messzeitpunkt (`MeasuredAt`), den
CO₂-Wert in ppm (`Ppm`), eine Segmentkennung (`Segment`) und den Empfangszeitpunkt
im Backend (`ReceivedAt`). Die Typen im Diagramm entsprechen den C#-Eigenschaften.
Alle Eigenschaften besitzen öffentliche Getter und Init-Setter; `Source` und
`Segment` sind zusätzlich als `required` deklariert.

Für im Browser empfangene `LIVE_SAMPLE` bezeichnet `MeasuredAt` die Zeit des
Empfangs im Browser, nicht die Messzeit oder UTC-Zeit des Sensors.

EF Core bildet die Entität auf die Tabelle `measurements` ab.
`MeasurementId` ist der Primärschlüssel. Die Datenbank begrenzt `Source` auf
`simulator` oder `sensor`, `Ppm` auf 1–100000 und `Segment` auf eine nicht leere
Zeichenfolge mit maximal 80 Zeichen. Beide Zeitpunkte werden als
`timestamp with time zone` gespeichert; der API-Code verwendet UTC.

Es gibt keine implementierten Domänenbeziehungen, Navigationseigenschaften oder
Fremdschlüsselbeziehungen zu anderen Entitäten. `DeviceId` ist lediglich eine
skalare Gerätekennung; eine Entität `Device` oder `Room` existiert im aktuellen
Backend nicht. Deshalb enthält das Diagramm keine entsprechenden Klassen oder
Assoziationen. DTOs dienen dem Datentransfer und der `LueftlotseDbContext` dem
Datenzugriff; sie sind keine zusätzlichen Domänenentitäten.
