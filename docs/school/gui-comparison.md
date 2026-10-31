# Vergleich von Wireframe und fertiger Oberfläche

## Nachträglich erstellter Wireframe

![Nachträglich erstellter Wireframe](wireframe.svg)

*Wireframe der Browseroberfläche.*

Der Wireframe wurde nach der Implementierung anhand der vorhandenen
Browseroberfläche erstellt. Er ist eine vereinfachte Schwarz-Weiß-Darstellung
und kein ursprünglicher Entwurf. Sensorverbindung und Serververlauf sind zur
Veranschaulichung aufgeklappt; lokale Historie und Synchronisierung bleiben
eingeklappt. Tabellenzeilen sind Platzhalter. **Weitere laden** erscheint im
fertigen Programm nur, wenn die Serverantwort einen `nextCursor` enthält.

Die aktuelle CO₂-Vorschau ist vom Serververlauf getrennt und wird nicht
gespeichert. Die Sensorauswahl öffnet den bestehenden Gerätedialog von Chrome.
Der Serververlauf bietet den vorhandenen Zeitraumfilter, **Laden** sowie die
Spalten **Zeit**, **CO₂ (ppm)** und **Quelle**. Die Darstellung ergänzt keine
neuen Funktionen.

## Screenshot der fertigen Anwendung

![Fertige Browseroberfläche](application-screenshot.png)

*Screenshot der fertigen Browseroberfläche.*

Beim Vergleich stehen die Trennung von aktueller Sensoranzeige und Serverdaten,
die Anordnung der Bedienelemente und die reduzierte Tabelle im Vordergrund.
Farben, Symbole, exakte Abstände und responsive Details sind im Wireframe
bewusst vereinfacht.
