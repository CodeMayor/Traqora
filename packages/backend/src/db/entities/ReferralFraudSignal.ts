import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from "typeorm";

@Entity("referral_fraud_signals")
@Index(["referralCode", "createdAt"])
export class ReferralFraudSignal {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column()
  referralCode: string;

  @Column()
  type: "click" | "conversion";

  @Column({ nullable: true })
  refereeId: string | null;

  @Column({ nullable: true })
  ip: string | null;

  @Column({ nullable: true })
  userAgent: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
