# Präsentationsnotizen: Lüftlotse

Diagramme: [Domänenmodell](domain-model.puml),
[Architektur](architecture.puml) und
[GUI-Vergleich](gui-comparison.md).

**Zielzeit: 6 Minuten 20 Sekunden.** Die Stichpunkte sind Erinnerungen für den
Vortrag; Wartezeit und Klicks sind in den Demozeiten enthalten.

Vorbereitung vor dem Vortrag: Backend und PostgreSQL starten, Chrome öffnen,
ESP32 bereithalten und die Demodaten einmal erfolgreich importieren. Den
PowerShell-Aufruf und die Browser-Entwicklertools vorbereiten, damit während
der Demonstration keine Einrichtung nötig ist.

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
  Die Browser-Sitzung speichert gültige LIVE_SAMPLE-Werte in IndexedDB als
  `sensor` und überträgt sie automatisch über `POST /api/measurements/batch`.
- Ohne Verbindung verpasste Messungen werden nicht nachträglich wiederhergestellt.
- Serververlauf lädt Daten getrennt über HTTP. Die Antwort bleibt in der
  Oberfläche und wird nicht mit dem lokalen Verlauf vermischt.

### 2:10–3:00 · C# API, EF Core und PostgreSQL

- [Architekturdiagramm öffnen](architecture.puml) und mit Alt + D anzeigen.
- `GET /api/measurements` liest den Serververlauf; der Zeitraum begrenzt die
  Abfrage.
- `POST /api/measurements/batch` nimmt Messpakete an. Dieselbe UUID mit
  unveränderten Daten wird als Duplikat erkannt und nicht nochmals eingefügt.

## Live-Demonstration – ungefähr 2 Minuten 50 Sekunden

### 3:00–3:40 · CO₂ in Chrome empfangen

- [Anwendung in Chrome öffnen](http://localhost:4200/), **Sensor auswählen**
  anklicken und den Lüftlotse-Sensor wählen.
- Nach Verbindung auf einen neuen Messwert warten; Wert und ppm-Schwelle zeigen.
- Die Verbindung ist an der Taste **Trennen** erkennbar; für die weitere
  Demonstration verbunden bleiben.
- ppm bedeutet Teile pro Million. 1000 ppm CO₂ entsprechen 0,1 Prozent der Luft.
- Ohne ESP32: **Sensor nicht verfügbar** zeigen und erklären, dass der
  Serververlauf trotzdem funktioniert. In diesem Fall lässt sich der Live-Empfang
  nicht vorführen; gespeicherte Daten nicht als neue Sensormessung ausgeben.

### 3:40–4:10 · Lokales Speichern und automatische Übertragung

- Den gerade empfangenen Wert im lokalen IndexedDB-Speicher zeigen und den
  automatischen POST-Aufruf samt erfolgreicher Antwort in den Entwicklertools.
- Erklären: Zuerst speichert die Browser-Sitzung lokal, danach sendet sie an die
  C# API. Dafür ist kein weiterer Klick nötig.
- Bei einem API-Ausfall bleibt der Wert ausstehend; ein erneuter Versand behält
  ID und Daten. Den Ausfall nur erklären, nicht während der kurzen Demo erzeugen.

### 4:10–4:40 · Historie für den aktuellen Zeitraum

- Nach erfolgreicher Übertragung in den immer sichtbaren Filtern **Von** und
  **Bis** einen Zeitraum um den aktuellen Empfangszeitpunkt einstellen
  (Ende exklusiv). **Bis** etwas nach dem Empfangszeitpunkt wählen, damit der
  neue Wert im Zeitraum liegt. Dann **Verlauf anzeigen** anklicken.
- Reale Datensätze mit **Zeit** und **CO₂ (ppm)** zeigen. Die Zeit ist der Empfang
  im Browser (`MeasuredAt`). `source=sensor` in der GET-Antwort der Browser-
  Entwicklertools zeigen; Quelle ist keine sichtbare Tabellenspalte mehr.

### 4:40–5:10 · Zeit und CO₂ sortieren

- Auf **Zeit** klicken und erneut klicken: zuerst alte beziehungsweise neue
  Messungen zeigen. Danach **CO₂ (ppm)** zweimal anklicken: hohe beziehungsweise
  niedrige Werte zuerst. Pfeil und Zeilenreihenfolge zeigen.
  Die Sortierung gilt für den gesamten Zeitraum einschließlich weiterer Seiten;
  standardmäßig stehen neue Messungen oben.
- Bei vorhandener Folgeseite **Weitere laden** zeigen; die Sortierung bleibt
  über die Seiten hinweg erhalten.

### 5:10–5:50 · Wiederholte Übertragung

- [Demodaten öffnen](demo-measurements.json).
- [PowerShell-Befehl im Schul-README zeigen](README.md).
- Bereits vorhandene Demodaten erneut senden.
- Für diese separate Prüfung den Zeitraum 15.01.2026 11:00 bis 11:10
  (Europe/Berlin; Ende exklusiv) verwenden. Die Demodaten enthalten das Feld
  `source=simulator`; es bleibt in Daten und API erhalten, wird aber nicht in der
  Browser-Tabelle angezeigt.
- Die API-Antwort zeigen: `received=10`, `inserted=0`, `duplicates=10`.
- Mit **Verlauf anzeigen** den Demobereich neu laden: Die zehn Demodatensätze
  bleiben unverändert, durch den erneuten Import kommen keine Zeilen hinzu.
- Feste UUIDs und identische Messdaten machen die Wiederholung sicher.

## Schluss – ungefähr 30 Sekunden

### 5:50–6:20 · Ergebnis

- Im gezeigten Browserpfad werden empfangene Sensorwerte angezeigt, lokal
  gespeichert und automatisch an die Serverhistorie übertragen. Ohne Verbindung
  gibt es keine Nachlieferung.
- Angular/TypeScript, C# API, EF Core und PostgreSQL arbeiten als ein Ablauf
  zusammen.
- Eine Wiederholung derselben Übertragung erzeugt keine doppelten Messungen.
