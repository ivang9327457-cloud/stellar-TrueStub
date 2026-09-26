/**
 * Jest tests for RefundService idempotency guard — issue #153 & #322
 */

import {
  RefundService,
  InMemoryRefundStore,
  REFUND_ERROR_CODES,
} from "./refund.service";
import { AppError } from "../middleware/errorHandler";

function makeService() {
  const store = new InMemoryRefundStore();
  return { service: new RefundService(store), store };
}

const basePayload = {
  refundId: "refund-abc-123",
  escrowId: "escrow-xyz-456",
  amount: "100",
  currency: "USDC",
  claimedBy: "user-1",
};

describe("RefundService — idempotency guard (#153)", () => {
  describe("claimRefund", () => {
    it("marks a refund as claimed on first call and returns the record", async () => {
      const { service } = makeService();

      const record = await service.claimRefund(basePayload);

      expect(record.refundId).toBe(basePayload.refundId);
      expect(record.escrowId).toBe(basePayload.escrowId);
      expect(record.amount).toBe(basePayload.amount);
      expect(record.currency).toBe(basePayload.currency);
      expect(record.claimedBy).toBe(basePayload.claimedBy);
      expect(record.claimedAt).toBeTruthy();
    });

    it("throws RefundAlreadyClaimed on second call with the same refundId", async () => {
      const { service } = makeService();

      await service.claimRefund(basePayload);

      await expect(service.claimRefund(basePayload)).rejects.toMatchObject({
        statusCode: 409,
        code: REFUND_ERROR_CODES.ALREADY_CLAIMED,
      });
    });

    it("error message includes the refundId", async () => {
      const { service } = makeService();
      await service.claimRefund(basePayload);

      let caught: AppError | null = null;
      try {
        await service.claimRefund(basePayload);
      } catch (err) {
        caught = err as AppError;
      }

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain(basePayload.refundId);
    });

    it("allows independent claims for different refundIds", async () => {
      const { service } = makeService();

      await service.claimRefund({ ...basePayload, refundId: "refund-1" });
      const second = await service.claimRefund({ ...basePayload, refundId: "refund-2" });

      expect(second.refundId).toBe("refund-2");
    });

    it("throws 400 when refundId is missing", async () => {
      const { service } = makeService();

      await expect(
        service.claimRefund({ refundId: "", escrowId: "escrow-1" })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: REFUND_ERROR_CODES.INVALID_PAYLOAD,
      });
    });

    it("throws 400 when escrowId is missing", async () => {
      const { service } = makeService();

      await expect(
        service.claimRefund({ refundId: "refund-1", escrowId: "" })
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("getClaimStatus", () => {
    it("returns undefined for an unclaimed refundId", async () => {
      const { service } = makeService();
      expect(await service.getClaimStatus("non-existent")).toBeUndefined();
    });

    it("returns the claim record after it has been claimed", async () => {
      const { service } = makeService();

      await service.claimRefund(basePayload);
      const result = await service.getClaimStatus(basePayload.refundId);

      expect(result).not.toBeUndefined();
      expect(result!.refundId).toBe(basePayload.refundId);
    });
  });

  describe("cleanup", () => {
    it("removes records older than the retention window", async () => {
      const { service, store } = makeService();

      await service.claimRefund(basePayload);
      const existing = await store.get(basePayload.refundId);
      expect(existing).not.toBeUndefined();

      // Backdate to 100 days ago
      const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      await store.set(basePayload.refundId, { ...existing!, claimedAt: old });

      const removed = await service.cleanup(90);

      expect(removed).toBe(1);
      expect(store.size).toBe(0);
    });

    it("retains records within the retention window", async () => {
      const { service, store } = makeService();

      await service.claimRefund(basePayload);
      const removed = await service.cleanup(90);

      expect(removed).toBe(0);
      expect(store.size).toBe(1);
    });

    it("removes nothing when the store is empty", async () => {
      const { service } = makeService();
      expect(await service.cleanup(90)).toBe(0);
    });
  });

  describe("Multi-asset refund correctness (#322)", () => {
    it("ensures refunds on non-default asset escrows correctly pass the escrow asset (e.g., EURC)", async () => {
      const mockClient = {
        getEscrow: jest.fn().mockResolvedValue({
          contractId: "escrow-eurc-123",
          asset: { code: "EURC", issuer: "GA2HGBJIQAHO6LEJKILQ5543MABEEV5YQ2W7C57E8Y25NQKONZHPZ752" },
        }),
        resolveDispute: jest.fn().mockResolvedValue({ txHash: "mock_tx_hash_eurc" }),
      };

      const mockExecutor = {
        execute: async (claim: any) => {
          const escrowDetails = await mockClient.getEscrow({ contractId: claim.escrowId });
          const res = await mockClient.resolveDispute({
            contractId: claim.escrowId,
            escrowType: claim.escrowType,
            milestoneIndex: claim.milestoneIndex,
            distributions: [{ address: claim.refundTo, amount: Number(claim.amount) }],
            asset: escrowDetails?.asset,
          });
          return res;
        }
      };

      const store = new InMemoryRefundStore();
      const service = new RefundService(store, mockExecutor as any);

      const payload = {
        refundId: "refund-eurc-1",
        escrowId: "escrow-eurc-123",
        amount: "50",
        currency: "EURC",
        refundTo: "GBX7QZ4Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z",
        claimedBy: "user-eurc",
      };

      const result = await service.claimRefund(payload);

      expect(result.status).toBe("submitted");
      expect(result.txHash).toBe("mock_tx_hash_eurc");
      expect(mockClient.getEscrow).toHaveBeenCalledWith({ contractId: "escrow-eurc-123" });
      expect(mockClient.resolveDispute).toHaveBeenCalledWith(
        expect.objectContaining({
          asset: expect.objectContaining({ code: "EURC" }),
        })
      );
    });
  });
});
