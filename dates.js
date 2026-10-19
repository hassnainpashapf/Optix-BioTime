// Pure date helpers (no database), shared by the report engine and the device simulator.
const pad = (n) => String(n).padStart(2, '0');
export const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayMin = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 60000;
export const addDays = (day, n) => new Date((dayMin(day) + n * 1440) * 60000).toISOString().slice(0, 10);
