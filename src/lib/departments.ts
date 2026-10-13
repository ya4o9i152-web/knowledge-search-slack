// 部署マスタ。supabase/schema.sql の departments テーブルと一致させる
export const DEPARTMENTS = ["戦略", "業務", "IT", "人事", "営業", "管理"] as const;

export type Department = (typeof DEPARTMENTS)[number];

/**
 * 機密扱いの文書の閲覧区分。部署ではないが、仕組みは部署と同じ（この区分に所属する人だけが読める）。
 * 文書の取り込み時には付けない。取り込んだ後に、管理者が文書の区分を「機密」へ変更する（ガバナンス手順書）
 */
export const RESTRICTED_GROUP = "機密";

/** ユーザーの所属や、文書の区分として指定できる値（6部署＋機密） */
export const ACCESS_GROUPS: readonly string[] = [...DEPARTMENTS, RESTRICTED_GROUP];

export function isDepartment(value: string): value is Department {
  return (DEPARTMENTS as readonly string[]).includes(value);
}
