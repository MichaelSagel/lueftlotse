export function co2Status(ppm: number) {
  if (ppm < 1000) return { color: 'green', label: 'CO₂-Wert akzeptabel', hint: 'Unter 1000 ppm.' };
  if (ppm < 2000) return { color: 'yellow', label: 'Bitte lüften', hint: 'CO₂-Wert zwischen 1000 und 1999 ppm.' };
  return { color: 'red', label: 'Hoher CO₂-Wert', hint: 'Ab 2000 ppm · Bitte lüften.' };
}
