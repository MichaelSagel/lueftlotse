# Präsentationsnotizen: Lüftlotse

**Dauer:** ungefähr 6 Minuten und 20 Sekunden. Die Stichpunkte sind Erinnerungen, kein
ausformulierter Vortrag.

Diagramme: [Domänenmodell](domain-model.puml),
[Architektur](architecture.puml) und
[GUI-Vergleich](gui-comparison.md).

## Erklärung – ungefähr 3 Minuten

### 0:00–0:40 · Idee

- Lüftlotse zeigt, wann die Raumluft gelüftet werden sollte.
- Zwei getrennte Ansichten: aktueller CO₂-Wert vom Sensor und gespeicherte
  Messungen im Serververlauf.
- Der aktuelle Sensorwert wird nicht gespeichert.

### 0:40–1:25 · Modell `Measurement`

- Auf das Domänenmodell zeigen.
- Eine Messung hat UUID, Geräte-ID, Quelle, Messzeit, ppm-Wert, Segment und
  Empfangszeit im Backend.
- Eine Measurement-Entität; `DeviceId` ist eine Kennung, keine eigene
  Device-Entität.

### 1:25–2:10 · Angular und TypeScript

- Die Oberfläche läuft im Browser.
- Web Bluetooth verbindet Chrome mit dem ESP32 und zeigt neue gültige
  LIVE_SAMPLE-Werte.
- Serververlauf lädt Daten getrennt über HTTP. Die Antwort bleibt in der
  Oberfläche und wird nicht mit dem lokalen Verlauf vermischt.

### 2:10–3:00 · C# API, EF Core und PostgreSQL

- Auf das Architekturdiagramm zeigen: Angular → ASP.NET Core API → EF Core →
  PostgreSQL.
- `GET /api/measurements` liest den Serververlauf; der Zeitraum begrenzt die
  Abfrage.
- `POST /api/measurements/batch` nimmt Messpakete an. Dieselbe UUID mit
  unveränderten Daten wird als Duplikat erkannt und nicht nochmals eingefügt.

## Live-Demonstration – ungefähr 2 Minuten 50 Sekunden

### 3:00–4:00 · Aktueller CO₂-Wert

- In Chrome **Sensor auswählen** anklicken und den Lüftlotse-Sensor wählen.
- Nach Verbindung auf einen neuen Messwert warten; Wert und ppm-Schwelle zeigen.
- Der Wert ist eine Vorschau und wird nicht gespeichert.
- Ohne ESP32: **Sensor nicht verfügbar** zeigen und erklären, dass der
  Serververlauf trotzdem funktioniert.

### 4:00–5:10 · Serververlauf und Filter

- **Serververlauf** öffnen, Zeitraum 15.01.2026 11:00 bis 11:10 einstellen
  (Europe/Berlin; Ende exklusiv) und **Laden** anklicken.
- Tabelle mit Zeit, CO₂ und Quelle zeigen.
- Zeitraum ändern und erneut laden: andere Filter liefern einen anderen
  Ausschnitt der PostgreSQL-Daten.

### 5:10–5:50 · Wiederholte Übertragung

- Datei [demo-measurements.json](demo-measurements.json) und den PowerShell-Aufruf
  im [Schul-README](README.md) zeigen.
- Bereits vorhandene Demodaten erneut senden.
- Die API-Antwort zeigen: `received=10`, `inserted=0`, `duplicates=10`.
- Serververlauf neu laden: Es bleiben dieselben zehn Datensätze, ohne zusätzliche
  Zeilen.
- Feste UUIDs und identische Messdaten machen die Wiederholung sicher.

## Schluss – ungefähr 30 Sekunden

### 5:50–6:20 · Ergebnis

- Aktueller Sensorwert und gespeicherte Serverhistorie haben getrennte Wege.
- Angular/TypeScript, C# API, EF Core und PostgreSQL arbeiten als ein Ablauf
  zusammen.
- Eine Wiederholung derselben Übertragung erzeugt keine doppelten Messungen.
