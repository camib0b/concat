import { LanguageProvider } from "@camib0b/ui";
import { BrowserRouter } from "react-router-dom";
import en from "@/i18n/en";
import es from "@/i18n/es";
import Concat from "@/pages/Concat";

const messages = { en, es };

export default function App() {
  return (
    <LanguageProvider messages={messages}>
      <BrowserRouter basename="/concat">
        <Concat />
      </BrowserRouter>
    </LanguageProvider>
  );
}
