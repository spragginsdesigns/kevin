// The "five years of real deadlines" chart reads data/sim-report.json (written by `npm run sim`).
// Vite resolves the glob at build time: when the real report exists it wins automatically; until
// then the clearly labelled placeholder fixture keeps the section renderable.
import placeholder from '../fixtures/sim-report.json';

const real = import.meta.glob('../../../data/sim-report.json', { eager: true, import: 'default' });
const realReport = Object.values(real)[0];

export const simReport = realReport || placeholder;
export const simIsPlaceholder = !realReport || Boolean(simReport.placeholder);
