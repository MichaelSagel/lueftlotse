import { co2Status } from './co2-status';

describe('co2Status', () => {
  it.each([[999, 'green'], [1000, 'yellow'], [1999, 'yellow'], [2000, 'red']])(
    'classifies %i ppm as %s', (ppm, color) => {
      expect(co2Status(Number(ppm)).color).toBe(color);
    },
  );
});
