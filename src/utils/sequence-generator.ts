import prisma from './prisma';

/**
 * Generate the next unique sequential number for any entity table.
 * It finds the maximum numeric suffix among existing records with matching prefix,
 * increments it, and verifies availability so unique constraint collisions never occur.
 */
export async function getNextSequenceNumber(
  model: string,
  field: string,
  prefix: string,
  padLength: number = 6,
  tx?: any
): Promise<string> {
  const client = tx || prisma;

  const records = await (client[model] as any).findMany({
    where: {
      [field]: {
        startsWith: prefix,
      },
    },
    select: {
      [field]: true,
    },
  });

  let maxSeq = 0;
  for (const r of records) {
    const val: string = r[field] || '';
    const suffix = val.slice(prefix.length);
    const num = parseInt(suffix, 10);
    if (!isNaN(num) && num > maxSeq) {
      maxSeq = num;
    }
  }

  let nextSeq = maxSeq + 1;
  let candidate = `${prefix}${String(nextSeq).padStart(padLength, '0')}`;

  // Extra safety check to guarantee candidate is completely free
  while (
    await (client[model] as any).findFirst({
      where: { [field]: candidate },
      select: { [field]: true },
    })
  ) {
    nextSeq++;
    candidate = `${prefix}${String(nextSeq).padStart(padLength, '0')}`;
  }

  return candidate;
}

export async function generateTripNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('trip', 'tripNumber', `TRP-${year}-`, 6, tx);
}

export async function generateOrderNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('customerOrder', 'orderNumber', `ORD-${year}-`, 6, tx);
}

export async function generatePurchaseRequestNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('purchaseRequest', 'requestNumber', `PR-${year}-`, 5, tx);
}

export async function generatePurchaseOrderNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('purchaseOrder', 'poNumber', `PO-${year}-`, 5, tx);
}

export async function generateGrnNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('goodsReceiptNote', 'grnNumber', `GRN-${year}-`, 6, tx);
}

export async function generatePaymentRequestNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('paymentRequest', 'requestNumber', `PAY-${year}-`, 6, tx);
}

export async function generateWorkOrderNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('workOrder', 'workOrderNumber', `WO-${year}-`, 5, tx);
}

export async function generateAccidentNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('accidentRecord', 'accidentNumber', `ACC-${year}-`, 5, tx);
}

export async function generateCashTransferNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('cashTransfer', 'transferNumber', `CT-${year}-`, 5, tx);
}

export async function generateApprovalRequestNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('approvalRequest', 'requestNumber', `APR-${year}-`, 5, tx);
}

export async function generateJournalEntryNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('journalEntry', 'entryNumber', `JE-${year}-`, 6, tx);
}

export async function generateRentalEmpNumber(tx?: any): Promise<string> {
  return getNextSequenceNumber('employee', 'empNumber', 'RNT-', 5, tx);
}

export async function generateRevenueShareContractNumber(tx?: any): Promise<string> {
  const year = new Date().getFullYear();
  return getNextSequenceNumber('revenueShareContract', 'contractNumber', `RSC-${year}-`, 4, tx);
}

export async function generateRevenueShareSettlementNumber(year: number, month: number, tx?: any): Promise<string> {
  const prefix = `RSS-${year}-${String(month).padStart(2, '0')}-`;
  return getNextSequenceNumber('revenueShareSettlement', 'settlementNumber', prefix, 4, tx);
}


