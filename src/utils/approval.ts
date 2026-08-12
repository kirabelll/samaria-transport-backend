import prisma from './prisma';

/**
 * Check if an action requires approval based on rules
 */
export async function requiresApproval(type: string, amount?: number): Promise<boolean> {
  const rule = await prisma.approvalRule.findUnique({ where: { type } });
  if (!rule || !rule.isActive) return false;
  if (rule.thresholdAmount && amount !== undefined) {
    return amount >= rule.thresholdAmount;
  }
  return true; // Active rule with no threshold = always requires approval
}

/**
 * Create an approval request
 */
export async function createApprovalRequest(data: {
  type: string;
  entityType: string;
  entityId: string;
  requestedBy?: string;
  description: string;
  amount?: number;
  currentData?: any;
  proposedData?: any;
  priority?: string;
}): Promise<any> {
  const year = new Date().getFullYear();
  const count = await prisma.approvalRequest.count();
  const requestNumber = `APR-${year}-${String(count + 1).padStart(5, '0')}`;

  return prisma.approvalRequest.create({
    data: {
      requestNumber,
      type: data.type,
      entityType: data.entityType,
      entityId: data.entityId,
      requestedBy: data.requestedBy,
      description: data.description,
      amount: data.amount,
      currentData: data.currentData ? JSON.stringify(data.currentData) : null,
      proposedData: data.proposedData ? JSON.stringify(data.proposedData) : null,
      priority: data.priority || 'normal',
      status: 'pending',
    },
  });
}

/**
 * Execute the underlying action after approval
 */
export async function executeApproval(approval: any): Promise<{ success: boolean; message: string }> {
  try {
    switch (approval.type) {
      case 'penalty_waiver': {
        await prisma.orderPenalty.update({
          where: { id: approval.entityId },
          data: { status: 'waived', waivedBy: approval.approvedBy, waivedReason: 'Approved via approval workflow' },
        });
        return { success: true, message: 'Penalty waived' };
      }
      case 'compliance_unlock': {
        await prisma.vehicle.update({
          where: { id: approval.entityId },
          data: { complianceLocked: false, lockReason: null, lockedAt: null, operationalStatus: 'idle' },
        });
        return { success: true, message: 'Vehicle unlocked' };
      }
      case 'cash_transfer': {
        await prisma.cashTransfer.update({
          where: { id: approval.entityId },
          data: { status: 'approved', approvedBy: approval.approvedBy, approvedAt: new Date() },
        });
        return { success: true, message: 'Cash transfer approved' };
      }
      case 'large_advance': {
        await prisma.driverAdvance.update({
          where: { id: approval.entityId },
          data: { status: 'approved', approvedById: approval.approvedBy, approvedAt: new Date() },
        });
        return { success: true, message: 'Advance approved' };
      }
      case 'settlement_override': {
        await prisma.settlement.update({
          where: { id: approval.entityId },
          data: { status: 'approved', approvedBy: approval.approvedBy },
        });
        return { success: true, message: 'Settlement approved' };
      }
      default:
        return { success: true, message: `Approval recorded for ${approval.type}` };
    }
  } catch (e: any) {
    return { success: false, message: e.message };
  }
}
