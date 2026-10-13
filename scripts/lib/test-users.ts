import type { Department } from "../../src/lib/departments";

/**
 * 権限検証用のテストユーザー。seed-test-users.ts が登録し、check-rls.ts が検証に使う。
 * slackUserId は仮の値。Slack連携の実装時に、検証に使う実際のSlackユーザーIDへ差し替える。
 */
export type TestUser = {
  key: string;
  email: string;
  slackUserId: string;
  displayName: string;
  departments: Department[];
};

export const TEST_USERS: TestUser[] = [
  { key: "strategy", email: "case7-test-strategy@example.com", slackUserId: "UTEST_STRATEGY", displayName: "テスト（戦略）", departments: ["戦略"] },
  { key: "operations", email: "case7-test-operations@example.com", slackUserId: "UTEST_OPERATIONS", displayName: "テスト（業務）", departments: ["業務"] },
  { key: "it", email: "case7-test-it@example.com", slackUserId: "UTEST_IT", displayName: "テスト（IT）", departments: ["IT"] },
  { key: "hr", email: "case7-test-hr@example.com", slackUserId: "UTEST_HR", displayName: "テスト（人事）", departments: ["人事"] },
  { key: "sales", email: "case7-test-sales@example.com", slackUserId: "UTEST_SALES", displayName: "テスト（営業）", departments: ["営業"] },
  { key: "admin", email: "case7-test-admin@example.com", slackUserId: "UTEST_ADMIN", displayName: "テスト（管理）", departments: ["管理"] },
  // テスト質問9（コスト削減効果のある案件をすべて → 戦略・ITの2文書。営業の文書には記載が無い）の検証用
  { key: "multi", email: "case7-test-multi@example.com", slackUserId: "UTEST_MULTI", displayName: "テスト（兼務：戦略・IT・営業）", departments: ["戦略", "IT", "営業"] },
  // 全部署を見てよい人（経営層など）。部署の制限に助けられない状態で検索の順位を確かめるためにも使う
  { key: "all", email: "case7-test-all@example.com", slackUserId: "UTEST_ALL", displayName: "テスト（全部署）", departments: ["戦略", "業務", "IT", "人事", "営業", "管理"] },
  // 所属が未登録のユーザーには何も見えないことの検証用
  { key: "none", email: "case7-test-none@example.com", slackUserId: "UTEST_NONE", displayName: "テスト（所属なし）", departments: [] },
];
