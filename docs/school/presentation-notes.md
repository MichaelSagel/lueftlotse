# Präsentationsnotizen: Lüftlotse

Diagramme: [Domänenmodell](domain-model.puml),
[Architektur](architecture.puml) und
[GUI-Vergleich](gui-comparison.md).

## Erklärung – ungefähr 3 Minuten

### 0:00–0:40 · Idee

- Lüftlotse zeigt, wann die Raumluft gelüftet werden sollte.
- Zwei getrennte Ansichten: aktueller CO₂-Wert vom Sensor und gespeicherte
  Messungen im Serververlauf.
- Empfangene Browser-Messwerte werden lokal gespeichert und automatisch über
  die C# API nach PostgreSQL übertragen. Der Serververlauf zeigt diese Messungen.

### 0:40–1:25 · Modell `Measurement`

- Auf das Domänenmodell zeigen. [Domänenmodell öffnen](domain-model.puml) und mit Alt + D als Diagramm anzeigen.
- Eine Messung hat UUID, Geräte-ID, Quelle, Messzeit, ppm-Wert, Segment und
  Empfangszeit im Backend.
- `MeasuredAt` ist beim Browserpfad die Zeit des Empfangs im Browser, nicht die
  Messzeit des Sensors. Die Empfangszeit im Backend ist davon getrennt.
- Eine Measurement-Entität; `DeviceId` ist eine Kennung, keine eigene
  Device-Entität.

### 1:25–2:10 · Angular und TypeScript

- Die Oberfläche läuft im Browser.
- Web Bluetooth ist eine integrierte Schnittstelle von Chrome.
  Mein TypeScript-Code nutzt sie, um Messwerte vom ESP32 zu empfangen.
  Gültige LIVE_SAMPLE-Werte werden in IndexedDB als `sensor` gespeichert und
  automatisch über `POST /api/measurements/batch` übertragen.
- Ohne Verbindung verpasste Messungen werden nicht nachträglich wiederhergestellt.
  Android ist von dieser Änderung nicht betroffen.
- Serververlauf lädt Daten getrennt über HTTP. Die Antwort bleibt in der
  Oberfläche und wird nicht mit dem lokalen Verlauf vermischt.

### 2:10–3:00 · C# API, EF Core und PostgreSQL

- [Architekturdiagramm öffnen](architecture.puml) und mit Alt + D anzeigen.
- `GET /api/measurements` liest den Serververlauf; der Zeitraum begrenzt die
  Abfrage.
- `POST /api/measurements/batch` nimmt Messpakete an. Dieselbe UUID mit
  unveränderten Daten wird als Duplikat erkannt und nicht nochmals eingefügt.

## Live-Demonstration – ungefähr 2 Minuten 50 Sekunden

### 3:00–4:00 · Aktueller CO₂-Wert

- [Anwendung in Chrome öffnen](http://localhost:4200/), **Sensor auswählen**
  anklicken und den Lüftlotse-Sensor wählen.
- Nach Verbindung auf einen neuen Messwert warten; Wert und ppm-Schwelle zeigen.
- ppm bedeutet Teile pro Million. 1000 ppm CO₂ entsprechen 0,1 Prozent der Luft.
- Der empfangene Wert wird lokal gespeichert und automatisch übertragen.
  Bei einem API-Ausfall bleibt er ausstehend; ein erneuter Versand behält ID und Daten.
- Ohne ESP32: **Sensor nicht verfügbar** zeigen und erklären, dass der
  Serververlauf trotzdem funktioniert.

### 4:00–5:10 · Serververlauf und Filter

- Nach erfolgreicher Übertragung in den immer sichtbaren Filtern **Von** und
  **Bis** einen Zeitraum um den aktuellen Empfangszeitpunkt einstellen
  (Ende exklusiv) und **Verlauf anzeigen** anklicken.
- Reale Datensätze mit **Zeit** und **CO₂ (ppm)** zeigen. Die Zeit ist der Empfang
  im Browser (`MeasuredAt`). `source=sensor` in der GET-Antwort der Browser-
  Entwicklertools zeigen; Quelle ist keine sichtbare Tabellenspalte mehr.
- Auf **Zeit** oder **CO₂ (ppm)** klicken: Pfeil und Richtung wechseln.
  Die Sortierung gilt für den gesamten Zeitraum einschließlich weiterer Seiten;
  standardmäßig stehen neue Messungen oben.
- Zeitraum ändern und erneut laden: andere Filter liefern einen anderen
  Ausschnitt der PostgreSQL-Daten.

### 5:10–5:50 · Wiederholte Übertragung

- [Demodaten öffnen](demo-measurements.json).
- [PowerShell-Befehl im Schul-README zeigen](README.md).
- Bereits vorhandene Demodaten erneut senden.
- Für diese separate Prüfung den Zeitraum 15.01.2026 11:00 bis 11:10
  (Europe/Berlin; Ende exklusiv) verwenden. Die Demodaten enthalten das Feld
  `source=simulator`; es bleibt in Daten und API erhalten, wird aber nicht in der
  Browser-Tabelle angezeigt.
- Die API-Antwort zeigen: `received=10`, `inserted=0`, `duplicates=10`.
- Serververlauf neu laden: Es bleiben dieselben zehn Datensätze, ohne zusätzliche
  Zeilen.
- Feste UUIDs und identische Messdaten machen die Wiederholung sicher.

## Schluss – ungefähr 30 Sekunden

### 5:50–6:20 · Ergebnis

- Empfangene Sensorwerte werden angezeigt, lokal gespeichert und automatisch
  an die Serverhistorie übertragen. Ohne Verbindung gibt es keine Nachlieferung.
- Angular/TypeScript, C# API, EF Core und PostgreSQL arbeiten als ein Ablauf
  zusammen.
- Eine Wiederholung derselben Übertragung erzeugt keine doppelten Messungen.
