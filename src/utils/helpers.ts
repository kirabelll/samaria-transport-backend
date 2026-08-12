import { format } from 'date-fns';

export const generateNumber = (prefix: string, id: string): string => {
  const year = new Date().getFullYear();
  const seq = id.slice(-6).toUpperCase();
  return `${prefix}-${year}-${seq}`;
};

export const calcShortage = (loaded: number, delivered: number): number => {
  return Math.max(0, loaded - delivered);
};

export const calcRevenue = (tons: number, ratePerTon: number): number => {
  return tons * ratePerTon;
};

export const calcDepreciation = (
  cost: number, residual: number, life: number, method: string
): number => {
  if (method === 'straight_line') {
    return (cost - residual) / (life * 12);
  }
  // declining balance
  const rate = (1 / life) * 2;
  return cost * rate / 12;
};

export const calcTripCycleMinutes = (departure?: Date | null, unloadingEnd?: Date | null): number => {
  if (!departure || !unloadingEnd) return 0;
  return Math.round((unloadingEnd.getTime() - departure.getTime()) / 60000);
};

export const formatCurrency = (amount: number): string => {
  return new Intl.NumberFormat('en-ET', { style: 'currency', currency: 'ETB' }).format(amount);
};
