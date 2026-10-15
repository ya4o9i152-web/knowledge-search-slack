import Image from "next/image";

// このアプリの利用者はSlackから質問するため、Webの画面は持たない（受け口は/api/slack/eventsと定期実行のみ）。
// トップページは、URLを開いた人に「何のアプリか」を伝える説明だけを置く
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-14 sm:px-6">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium text-blue-700">Slack 連携 ・ 部署別アクセス制御</p>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">ナレッジ検索AI</h1>
        <p className="text-base leading-7 text-slate-600">
          Slack で質問すると、過去の提案書・報告書から関連する文書を見つけて、要点・該当箇所・原本へのリンクを返します。
          検索の対象は、質問した人の所属部署の文書だけです。
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { title: "Slack で質問", body: "ボットへのメンション、または個人宛てのメッセージで質問できます。" },
          { title: "所属部署の文書だけ", body: "データベースの行単位の制限（RLS）で、他部署の文書は検索結果に出ません。" },
          { title: "利用記録を保存", body: "誰が・いつ・何を検索し、どの文書が返ったかを記録し、月次で集計します。" },
        ].map((item) => (
          <div key={item.title} className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-base font-bold text-slate-900">{item.title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold text-slate-900">しくみ</h2>
        <Image
          src="/architecture-simple.png"
          alt="ナレッジ検索AIのしくみ。文書を毎日読み込み、Slackの質問に対して所属部署の文書だけを検索し、要点をまとめて返す"
          width={1800}
          height={2380}
          className="h-auto w-full rounded-xl border border-slate-200"
          priority
        />
      </section>

      <footer className="border-t border-slate-200 pt-6 text-sm text-slate-500">
        この画面は説明用です。ご利用は Slack からお願いします。
      </footer>
    </main>
  );
}
