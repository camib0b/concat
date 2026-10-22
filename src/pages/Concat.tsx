import { useEffect } from "react";
import { SiteHeader, useLanguage } from "@camib0b/ui";
import ConcatTool from "@/components/concat/ConcatTool";

/** Public route: `/concat` — browser-only join for split match footage. */
const Concat = () => {
  const { t } = useLanguage();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = t("concat.document.title");
    return () => {
      document.title = previousTitle;
    };
  }, [t]);

  return (
    <main className="relative min-h-screen bg-background">
      <SiteHeader backLabel={t("concat.back")} />
      <div className="container relative z-10 mx-auto max-w-3xl px-6 py-16 md:px-8">
        <p className="mb-2 text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("concat.eyebrow")}</p>
        <h1 className="mb-3 text-2xl font-medium tracking-tight">{t("concat.title")}</h1>
        <p className="mb-8 max-w-xl text-sm leading-6 text-muted-foreground">{t("concat.description")}</p>
        <ConcatTool />
      </div>
    </main>
  );
};

export default Concat;
