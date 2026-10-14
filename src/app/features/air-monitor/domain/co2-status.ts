export function co2Status(ppm: number) {
  if (ppm < 1000) return { color: 'green', label: 'Niedriger CO₂-Wert', hint: 'Unter der ersten Demo-Schwelle.' };
  if (ppm < 2000) return { color: 'yellow', label: 'Erhöhter CO₂-Wert', hint: 'Zwischen den beiden Demo-Schwellen.' };
  return { color: 'red', label: 'Hoher CO₂-Wert', hint: 'Ab der zweiten Demo-Schwelle.' };
}
