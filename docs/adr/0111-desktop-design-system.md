# ADR-0111: System projektowy aplikacji desktopowej: Tailwind i komponenty w stylu shadcn/ui w `ui/`

- Status: Proposed
- Data: 2026-11-24

## Kontekst
Aplikacja nie ma warstwy systemu projektowego: jeden globalny `styles.css` (ok. 4000 linii, 464 selektory potomków), 196 surowych `<button>` z klasami `primary`/`ghost` wpisywanymi ręcznie, własne implementacje zakładek, menu kontekstowego, podziału paneli i palety „go to”. Właściciel zdecydował (2026-11-24): własny system projektowy oparty na shadcn/ui.

## Decyzja
1. **Tailwind CSS v4** (`tailwindcss`, `@tailwindcss/vite`) bez preflightu (resetu bazowego): `src/ui/theme.css` mapuje tokeny `:root` aplikacji na motyw Tailwinda (`bg-panel`, `text-muted`, `border-edge`, `gap-sp-3`), a dotychczasowy `styles.css` jest warstwą `legacy` pod narzędziami Tailwinda. Wygląd zostaje, a nowy kod pisze się narzędziami.
2. **Komponenty w stylu shadcn/ui w `src/ui/`**: kod w repozytorium, nie zależność; warianty przez `class-variance-authority`, łączenie klas przez `cn` (`clsx` + `tailwind-merge`); zachowanie (fokus, klawiatura, ARIA) z prymitywów Radix (`radix-ui`) tam, gdzie aplikacja pisała je sama. Wariant komponentu daje dotychczasową klasę (`primary`, `ghost`), więc testy e2e szukające po klasach działają dalej.
3. **Jeden przycisk**: każdy przycisk aplikacji to `<Button>` z `ui/button.tsx`; reguła E1 odrzuca surowy `<button>` poza `ui/`.
4. **Gotowe prymitywy tam, gdzie dają zachowanie, którego aplikacja nie ma**: menu kontekstowe to `DropdownMenu` z Radix zakotwiczony w punkcie kliknięcia, zakładki to `Tabs` z Radix. Paleta „go to” (filtrowanie `gotoRows` i klawisze filtrów), komunikat powłoki (odmowa zostaje do zamknięcia, D5) i podział paneli (drzewo proporcji zapisywane w układzie demona) zostają własne: `cmdk`, `sonner` i `react-resizable-panels` wniosłyby własne filtrowanie, czas życia komunikatów i model układu, które trzeba by wyłączać.

## Stan realizacji
- Zrobione: punkty 1–4. Przyciski (192) są `<Button>`; zakładki i menu kontekstowe na Radix; menu ma wygląd z narzędzi Tailwinda.
- Następne: kolejne komponenty `ui/` (pole formularza, karta, plakietka) i przenoszenie stylów ekranów z warstwy `legacy` do narzędzi, ekran po ekranie.

## Konsekwencje
### Pozytywne
- Wygląd elementu zmienia się w jednym miejscu; nowe style nie dokładają globalnych selektorów.
- Dostępność zakładek, menu i dialogów z przetestowanych prymitywów.

### Negatywne
- Przez okres przejściowy dwa źródła stylów (warstwa `legacy` i narzędzia Tailwinda).
- Więcej zależności w paczce aplikacji.

## Alternatywy odrzucone
- **Biblioteka komponentów jako zależność (MUI, Chakra)**: obcy język wizualny i motyw do nadpisywania; shadcn/ui to kod w repozytorium.
- **Tailwind z preflightem**: zmieniłby wygląd każdego istniejącego elementu naraz.
- **`cmdk`, `sonner`, `react-resizable-panels` w miejsce palety, komunikatu i podziału paneli**: ich filtrowanie, czas życia komunikatów i model układu różnią się od tego, co aplikacja już robi i testuje; zysk mniejszy niż ryzyko.
- **CSS Modules bez Tailwinda**: tokeny i warianty trzeba by pisać od nowa w każdym module.

## Implikacje dla kodu
- `packages/desktop/src/ui/` (`theme.css`, `cn.ts`, `button.tsx` i kolejne komponenty), `packages/desktop/vite.config.ts` (wtyczka Tailwinda).
- Rejestr zależności: `tailwindcss`, `@tailwindcss/vite`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`.
