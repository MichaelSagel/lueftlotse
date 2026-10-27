import { co2Status } from './co2-status';

describe('co2Status', () => {
  it.each([
    [999, 'green', 'CO₂-Wert akzeptabel', 'Unter 1000 ppm.'],
    [1000, 'yellow', 'Bitte lüften', 'CO₂-Wert zwischen 1000 und 1999 ppm.'],
    [1999, 'yellow', 'Bitte lüften', 'CO₂-Wert zwischen 1000 und 1999 ppm.'],
    [2000, 'red', 'Hoher CO₂-Wert', 'Ab 2000 ppm · Bitte lüften.'],
  ])(
    'classifies %i ppm as %s with a German action', (ppm, color, label, hint) => {
      expect(co2Status(Number(ppm))).toEqual({ color, label, hint });
    },
  );
});
