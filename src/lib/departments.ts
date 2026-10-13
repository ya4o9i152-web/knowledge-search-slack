// 部署マスタ。supabase/schema.sql の departments テーブルと一致させる
export const DEPARTMENTS = ["戦略", "業務", "IT", "人事", "営業", "管理"] as const;

export type Department = (typeof DEPARTMENTS)[number];

export function isDepartment(value: string): value is Department {
  return (DEPARTMENTS as readonly string[]).includes(value);
}
