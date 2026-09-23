import { frontSequelize } from "@app/lib/resources/storage";
import { DataTypes } from "@app/lib/resources/storage/data_types";
import type {
  CreationOptional,
  InferAttributes,
  InferCreationAttributes,
} from "sequelize";
import { Model } from "sequelize";

/** Durable Front generation accounting, independent of the tenant Redis stream. */
export class DustUsageAttemptModel extends Model<
  InferAttributes<DustUsageAttemptModel>,
  InferCreationAttributes<DustUsageAttemptModel>
> {
  declare attemptId: string;
  declare tenantId: string;
  declare workspaceId: string;
  declare conversationId: string;
  declare model: string;
  declare routeId: string;
  declare routeBindingHash: string | null;
  declare identityHash: string;
  declare state: CreationOptional<
    "started" | "unknown" | "exact" | "no_charge" | "manual_review_required"
  >;
  declare providerOperationId: string | null;
  declare noChargeEvidenceRef: string | null;
  declare noChargeEvidenceHash: string | null;
  declare eventEnvelope: string | null;
  declare eventHash: string | null;
  declare deliveredAt: Date | null;
  declare firstUnresolvedAt: Date | null;
  declare retryCount: CreationOptional<number>;
  declare manualReviewRequired: CreationOptional<boolean>;
  declare nextRetryAt: Date | null;
  declare leaseOwner: string | null;
  declare leaseNonce: string | null;
  declare leaseUntil: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

DustUsageAttemptModel.init(
  {
    attemptId: {
      type: DataTypes.STRING(128),
      primaryKey: true,
      allowNull: false,
    },
    tenantId: { type: DataTypes.STRING(128), allowNull: false },
    workspaceId: { type: DataTypes.STRING(256), allowNull: false },
    conversationId: { type: DataTypes.STRING(256), allowNull: false },
    model: { type: DataTypes.STRING(256), allowNull: false },
    routeId: { type: DataTypes.STRING(256), allowNull: false },
    routeBindingHash: { type: DataTypes.STRING(64), allowNull: true },
    identityHash: { type: DataTypes.STRING(64), allowNull: false },
    state: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "started",
    },
    providerOperationId: { type: DataTypes.STRING(256), allowNull: true },
    noChargeEvidenceRef: { type: DataTypes.STRING(256), allowNull: true },
    noChargeEvidenceHash: { type: DataTypes.STRING(64), allowNull: true },
    eventEnvelope: { type: DataTypes.STRING(16384), allowNull: true },
    eventHash: { type: DataTypes.STRING(64), allowNull: true },
    deliveredAt: { type: DataTypes.DATE, allowNull: true },
    firstUnresolvedAt: { type: DataTypes.DATE, allowNull: true },
    retryCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    manualReviewRequired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    nextRetryAt: { type: DataTypes.DATE, allowNull: true },
    leaseOwner: { type: DataTypes.STRING(128), allowNull: true },
    leaseNonce: { type: DataTypes.STRING(128), allowNull: true },
    leaseUntil: { type: DataTypes.DATE, allowNull: true },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    modelName: "dust_usage_attempt",
    tableName: "dust_usage_attempts",
    sequelize: frontSequelize,
    timestamps: false,
    indexes: [
      {
        name: "dust_usage_attempts_provider_operation_unique_idx",
        unique: true,
        fields: ["providerOperationId"],
      },
      {
        name: "dust_usage_attempts_reconcile_idx",
        fields: ["nextRetryAt", "leaseUntil"],
        where: {
          state: ["started", "unknown", "exact"],
          deliveredAt: null,
        },
      },
      {
        name: "dust_usage_attempts_tenant_unresolved_idx",
        fields: ["tenantId"],
        where: { state: ["started", "unknown", "manual_review_required"] },
      },
      {
        name: "dust_usage_attempts_tenant_delivery_idx",
        fields: ["tenantId", "createdAt"],
        where: { state: "exact", deliveredAt: null },
      },
    ],
  }
);
