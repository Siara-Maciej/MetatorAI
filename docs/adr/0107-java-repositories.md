# ADR-0107: Repozytoria Java: deterministyczne czytanie kodu, buildu i faktów frameworków

- Status: Proposed
- Data: 2026-11-23

## Kontekst
Właściciel (runda 22): „Następny krok to możliwość czytania i analizy repozytorium Java. Będę musiał przepisać aplikacje Java na TypeScript, więc chcę, żeby agent umiał je czytać i wyciągać informacje z repozytorium Java". Kod jest korporacyjny: Spring Boot (MVC, JPA), Spring WebFlux, Jakarta EE / JAX-RS, czysta Java; składnia od Javy 8 do 21; wielomodułowe buildy Maven i Gradle (Groovy i Kotlin DSL); konfiguracja w XML (beany Springa, `web.xml`, `persistence.xml`); EJB, CDI; źródła generowane.

Zakres tej rundy to **tylko czytanie**. Przepływ portowania (plany Java → TypeScript, mapowanie typów, testy zgodności) to późniejsza runda: model ma być na tyle bogaty, żeby mogła z niego planować. Zasada produktu obowiązuje: **komenda mierzy, model decyduje** — agenci dostają fakty z komend `metator java` z dowodem `plik:linia`, a nie zgadują z wyników grepa.

## Decyzja

### 1. Parser: web-tree-sitter z gramatyką tree-sitter-java (WebAssembly)
Kandydaci (ADR-0010: sprawdzony pakiet) zmierzeni na korpusie prawdziwego kodu: jary źródłowe z Maven Central (`scripts/java-corpus.ts`, pamięć podręczna poza repozytorium): `spring-webmvc 6.1.14`, `spring-webflux 6.1.14`, `spring-data-jpa 3.3.5`, `hibernate-core 6.6.1.Final`, `jakarta.ws.rs-api 3.1.0`, `guava 33.3.1-jre` i `lucene-core 10.1.0` (Java 21: rekordy, typy zapieczętowane, wzorce w `switch`). Razem 7 872 pliki, 48,2 MB.

| | `java-parser` 3.0.1 (Chevrotain, prettier-java) | `web-tree-sitter` 0.27.2 + `tree-sitter-java` 0.23.5 |
|---|---|---|
| Sparsowane w całości | 7 872 / 7 872 (100%) | 7 872 / 7 872 (100%) |
| Samo parsowanie | 466 plików/s (16,9 s) | 1 429 plików/s (5,5 s) |
| Szczytowa pamięć (RSS) | 1 182 MB | 138 MB |
| Plik z błędem składni | wyjątek, cały plik stracony | drzewo z węzłem `ERROR`/brakującym, deklaracje wokół błędu zostają |
| Java 21 w fiksturze (rekordy, `sealed`, `case Rectangle(double w, double h) when`) | tak | tak |

Wybór: **web-tree-sitter + tree-sitter-java**. Trzy razy szybszy, ośmiokrotnie mniej pamięci, a przede wszystkim odporny na błędy: plik, którego nie da się w pełni sparsować, jest zgłaszany (`parseFailures` z linią), a jego typy i tak trafiają do modelu (fiksture: `Broken.java` daje metody `half` i `fine`). Gramatyka to WebAssembly: bez JDK, bez dodatku natywnego, ta sama na każdej platformie. Nigdy nie uruchamiamy `javac` ani JVM do czytania.

Pełny odczyt (parsowanie i wyciągnięcie deklaracji, adnotacji, wywołań routera) na tym korpusie: 727 plików/s, 0 plików z błędem, szczyt 314 MB. Skala korporacyjna: ten sam korpus ułożony czterokrotnie jako jeden build Maven (28 modułów, **31 488 plików**), prawdziwe `metator java index`: na zimno 52,7 s (31 488 sparsowanych, 0 błędów, szczyt RSS 3,0 GB), z pamięcią podręczną 9,0 s (31 488 użytych ponownie, szczyt 2,3 GB); dokument indeksu 175 MB (zapisywany w jednej linii: wcięty miał 416 MB). Pamięć przy dziesiątkach tysięcy plików jest najsłabszym punktem: cały indeks jest wczytywany i walidowany (zod) naraz; podział indeksu na moduły to możliwy następny krok.

Wysyłka: dwa pliki `.wasm` (runtime `web-tree-sitter.wasm` 211 KB i gramatyka `tree-sitter-java.wasm` 415 KB) leżą w `metator-resources/wasm/` obok dodatków natywnych (ADR-0105); `scripts/compile-cli.ts` je kopiuje, `packages/cli/src/installation.ts` (`javaGrammarFiles`) wskazuje je skompilowanemu `metator`, a runtime podaje je parserowi. Uruchomione z checkoutu albo z npm, parser bierze je z `node_modules`. Brak gramatyki to błąd `BIN_NOT_FOUND` tylko komend `java`, nie całego programu. Identyfikator parsera (klucz pamięci podręcznej) zawiera wersję pakietu gramatyki.

XML (POM, `web.xml`, `persistence.xml`, Spring XML) czyta `saxes` (z numerami linii, do dowodów), YAML pakiet `yaml`, który już mamy.

### 2. Gdzie to żyje
- Nowy pakiet `packages/plugin-java`: importuje tylko `@metator/core` i implementuje porty: `TreeSitterJavaParser` (`JavaSourceParser`), `JavaBuildFiles` (`JavaBuildReader`), `JavaDescriptors` (`JavaDescriptorParser`), `JavaImportAnalyzer` (`ImportAnalyzer`, `SymbolAnalyzer`), `JavaWorkspace` (`WorkspaceReader`). Reguły architektury obejmują go przez wzorzec `packages/plugin-*`.
- Model domeny i fakty w core: `domain/java-model.ts` (dokument `JavaIndex`), `java-build.ts`, `java-repository.ts`, `java-endpoints.ts`, `java-persistence.ts`, `java-beans.ts`, `java-facts.ts`; przypadek użycia `application/java-reading.ts` (`ReadJava`); kompozyt analizatorów `application/language-analyzers.ts`.
- Runtime składa całość; CLI ma grupę `metator java`.

### 3. Czytanie na poziomie języka przez istniejące porty
- Runtime ma teraz **jeden analizator na wiele języków** (`AnalyzerByExtension`): plik idzie do analizatora swojego rozszerzenia (oxc dla TS/JS, Java dla `.java`), import rozwiązuje analizator pliku, w którym jest napisany. `graph dependents|affected|cycles`, `symbols find`, `graph callers`, `similar` i `cards` działają na plikach Java tak jak na TypeScript, także w repozytorium z oboma językami. Klucz indeksu importów to `oxc/1+java/1`.
- `ImportAnalyzer` dla Javy jest **leksykalny**: importy, pakiet i nazwy typów użyte w pliku to fakty leksykalne, więc daje je tokenizer, który nigdy nie zawodzi (komentarze, napisy, bloki tekstu i znaki pominięte). Powód: port jest synchroniczny, a tree-sitter w WebAssembly inicjuje się asynchronicznie; dodanie metody `prepare()` złamałoby limit pięciu członków portu (MT-ARCH-008), a każda komenda grafu płaciłaby ~20 ms za inicjalizację. Pełny parser służy modelowi (`metator java`).
  - `import a.b.C` → plik C; `import a.b.C.Inner` → plik C; `import static a.b.C.m` → plik C;
  - `import a.b.*` i własny pakiet pliku → plik każdego typu, którego plik używa, a który ten pakiet deklaruje (krawędzie bez importu, np. encja ↔ encja w jednym pakiecie);
  - typy JDK i bibliotek są zewnętrzne pod nazwą `java:<pakiet>` (nigdy nie wyglądają jak pakiet npm, więc reguły `arch` o deklaracjach w `package.json` ich nie dotyczą);
  - typ z pakietu repozytorium, którego żaden plik nie deklaruje, to `unresolved` (brakujący plik).
  - Indeks w pełni kwalifikowanych nazw obejmuje każdy plik `.java` repozytorium (każdy katalog źródeł każdego modułu); co plik deklaruje, czytają wzorce (pakiet i deklaracje najwyższego poziomu na początku linii, plus nazwa pliku). Ponieważ wynik `parse` zależy od tego indeksu, odcisk pliku Java zawiera skrót indeksu: dodany albo usunięty typ unieważnia wpisy Javy. Port `ImportAnalyzer.fingerprint` dostał opcjonalny drugi argument (ścieżkę), żeby kompozyt mógł odpowiedzieć za język pliku.
- `SymbolAnalyzer` dla Javy: typy najwyższego poziomu i ich publiczne składowe jako `Typ.składowa` (w interfejsie składowe są publiczne); importy po prostej nazwie.
- Zestaw kontraktowy `importAnalyzerContract` (`packages/testing/src/contracts/import-analyzer.contract.ts`, MT-TEST-002) przechodzi na oxc i na Javie.
- Domyślne globy testów obejmują `src/{test,it,integrationTest,testFixtures}/**/*.java`.

### 4. Build: moduły i katalogi źródeł, bez uruchamiania
- **Maven**: `pom.xml` z `<modules>` rekurencyjnie; moduły wymienione tylko w `<profiles>` są na liście z oznaczeniem `profile`; `<parent>` (nazwa modułu, gdy rodzic jest w buildzie, inaczej `g:a:v`); `<packaging>` (domyślnie `jar`); `<dependencies>` z zakresem (domyślnie `compile`), wersją z `<dependencyManagement>` łańcucha, gdy jej brak; `<build><sourceDirectory>`/`<testSourceDirectory>`. Placeholdery `${…}` rozwiązywane z właściwości łańcucha POM-ów w repozytorium i `project.*`; nieznane zostają tak, jak napisano. Wersja Javy: `<release>`/`<source>` wtyczki kompilatora, `maven.compiler.release`/`source`, `java.version`, wzdłuż łańcucha, z dowodem `plik:linia`. POM, który nie jest XML-em, to notatka, reszta jest czytana.
- **Gradle**: `settings.gradle(.kts)` `include(...)` (i `projectDir`), w każdym projekcie zależności według konfiguracji (`implementation(…)`, `api(project(":core"))`, notacja mapy), `sourceSets` zapisane prosto, wersja z `JavaLanguageVersion.of(n)`, `sourceCompatibility`, `release`; `$x` z `gradle.properties`. Korzeń jest modułem tylko, gdy sam buduje Javę.
- Katalogi źródeł: `src/main/java`, `src/test/java` i zadeklarowane; generowane (`target/generated-sources/*`, `build/generated/sources/*`) oznaczone `generated` i czytane w całości, nawet gdy git je ignoruje. Każdy katalog źródeł jest czytany w całości: pakiet może nazywać się jak katalog wyjścia buildu (`org.hibernate.internal.build`), a domyślne ignorowane wzorce (`**/build/**`) by go pominęły.
- Build w korzeniu wygrywa; bez niego czytane są buildy jeden lub dwa katalogi niżej (serwis Java obok aplikacji TS).
- **Moduły są pakietami workspace** (`JavaWorkspace` w `MergedWorkspace` za pakietami JavaScriptu, pole `build: "maven" | "gradle"`), więc `graph`, `affected`, `arch` i `cards` grupują po module. Agregator (`pom` bez źródeł) nie jest pakietem.

### 5. Model Javy (z czego zaplanuje późniejsze portowanie)
Jeden indeks repozytorium: dokument `JavaIndex` v1 (`.metator/index/java.json`, schemat zamrożony, ADR-0016, MT-CODE-003), wpis na plik unieważniany odciskiem treści (SHA-256); inny parser albo jego wersja przebudowuje wszystko. Każdy typ ma: rodzaj (class, interface, enum, record, annotation), pakiet, plik i linię (linię nazwy, nie adnotacji), modyfikatory, adnotacje z argumentami (wartość literału, tekst wyrażenia, elementy tablicy), parametry typu, `extends`, `implements`, `permits`; pola z typami, adnotacjami i wartością stałej; konstruktory i metody z parametrami, typem zwracanym, `throws` i adnotacjami; stałe enuma, komponenty rekordu, typy zagnieżdżone; moduł; czy to kod testowy albo generowany. Nazwy typów są kwalifikowane przez importy pliku, własny pakiet, importy `.*` i typy zagnieżdżone.

### 6. Fakty frameworków, każdy z dowodem
Każdy fakt ma `at` (`plik:linia`) i `evidence` (adnotacja, element XML albo wywołanie). Reguła, która nie może być pewna, mówi `confidence: "likely"`:
- **Endpointy**: Spring MVC (`@RestController`/`@Controller` + `@RequestMapping`/`@GetMapping`/…, ścieżka klasy złączona ze ścieżką metody, metoda HTTP albo `*`, parametry `@PathVariable`/`@RequestParam`/`@RequestBody`/`@RequestHeader`/…, typ żądania i odpowiedzi, `ResponseEntity<T>` rozpakowane; `@Controller` bez `@ResponseBody` nie ma typu odpowiedzi); WebFlux (`Mono<T>` → T, `Flux<T>` → `T[]`; DSL `RouterFunction`: `route().GET(...)`, `RouterFunctions.route(GET(...), handler)`, prefiksy `path`/`nest`, handler przez parametr albo pole — zawsze `likely`); JAX-RS (`@ApplicationPath` + `@Path` klasy + `@Path` metody, `@GET`/…, `@PathParam`/`@QueryParam`/…, parametr bez adnotacji to ciało, `@Produces`/`@Consumes` ze stałymi `MediaType`); Servlety (`@WebServlet` i mapowania `web.xml`, metody z nadpisanych `doX`). Ścieżka zbudowana ze stałej repozytorium (`ApiPaths.CUSTOMERS`) jest odczytywana z deklaracji stałej i jest `likely`.
- **Encje JPA** (javax i jakarta, adnotacje rozpoznawane po prostej nazwie): `@Entity`/`@Embeddable`/`@MappedSuperclass`, `@Table`, `@Id` z `@GeneratedValue`, `@Column` (name, nullable, length, unique), `@Enumerated`, `@Transient`, osadzenia; relacje z celem (`targetEntity`, element kolekcji, wartość mapy, typ pola), `mappedBy`, `@JoinColumn`; `@Inheritance`; dostęp przez gettery; jednostki `persistence.xml`; repozytoria Spring Data (interfejsy dziedziczące po bazie Spring Data bezpośrednio albo przez własny interfejs generyczny, z encją, id, metodami pochodnymi i `@Query`, także natywnymi; `@NoRepositoryBean` pominięte).
- **Beany i wiązania**: stereotypy Springa, metody `@Bean`, repozytoria Spring Data (wstrzykiwane interfejsy), CDI (zakresy, `@Named`), EJB (`@Stateless`, `@Stateful`, `@Singleton` — EJB albo JSR-330 według importu, `@MessageDriven`), `<bean>` Spring XML. Punkty wstrzyknięcia: pola `@Autowired`/`@Inject`/`@Resource`/`@EJB`, konstruktor (`@Autowired`/`@Inject`, a w Springu jedyny konstruktor; Lombok `@RequiredArgsConstructor`/`@AllArgsConstructor` — pola), settery i parametry metod `@Bean`, `<property ref>`/`<constructor-arg ref>`. Dostawca: po kwalifikatorze (`@Qualifier`, `@Named`, `@Resource(name)`, `ref`) albo po typie, **gdy pasuje dokładnie jeden bean** (`certain`); przy kilku — `@Primary` (`likely`) albo brak dostawcy z liczbą kandydatów.
- **Konfiguracja**: klucze `application*.properties` i `application*.yml` z profilem (z nazwy pliku albo z `spring.config.activate.on-profile`/`spring.profiles` dokumentu); odczyty `@Value("${klucz:domyślna}")` i pola klas `@ConfigurationProperties(prefix)` (także na metodzie `@Bean`), ze znacznikiem, czy jakiś klucz je definiuje (wiązanie luźne: `max-lines` = `maxLines` = `max_lines`).
- **Punkty wejścia**: statyczne `main`, `@Scheduled`/`@Schedule`, `@KafkaListener`/`@JmsListener`/`@RabbitListener`, `@EventListener`, beany `@MessageDriven` (z celem z `activationConfig`), `@Startup`, `CommandLineRunner`/`ApplicationRunner`.
- **Wykryte frameworki** z zależności buildu, adnotacji i deskryptorów, z liczbami i do pięciu dowodów.

### 7. Komendy
`metator java overview|modules|types|show|endpoints|entities|repositories|beans|config|entrypoints|index [--check]` — koperty JSON jak każda komenda i tekst dla osoby przy terminalu; każda komenda listy przyjmuje `--module` i `--package`, a `-C <repozytorium>` działa z folderu repozytoriów. `show <typ>` przyjmuje nazwę kwalifikowaną albo prostą, jeśli jest jedna; inaczej nowy kod błędu `AMBIGUOUS` (wyjście 64) z kandydatami. `index --check` zwraca `STALE_INDEX` (65) z listą zmienionych plików. Wszystkie czytają (narzędzia MCP); `overview`, `types`, `show`, `endpoints` i `beans` mają pola typowane.

### 8. Fikstura e2e
`e2e/fixtures/java/maven` („shop", wielomodułowy Maven: `shop-common` (Java 21, testy JUnit), `shop-domain` (JPA, Spring Data, źródło generowane), `shop-api` (Spring MVC, rekordy DTO, `@Value`, `@ConfigurationProperties`, `application.yml` z dwoma profilami), `shop-reactive` (WebFlux i `RouterFunction`), `legacy-ejb` (`war`: JAX-RS, EJB, CDI, Servlety, `web.xml`, `persistence.xml`, `applicationContext.xml`)) oraz `e2e/fixtures/java/gradle` („inventory", Kotlin DSL, dwa projekty). Plik z błędem składni (`shop-experimental/.../Broken.java`) jest w module wymienionym tylko w profilu `experimental`, nieaktywnym domyślnie, więc `mvn compile` i `mvn test` go nie budują, a czytanie go zgłasza. Oba buildy kompilują się prawdziwym Mavenem 3.9 i Gradle 8.14 z JDK 21. Repozytorium MetatorAI ignoruje `e2e/fixtures/**` w swoim grafie (encje fikstury mają cykl celowo).

## Konsekwencje
- Agenci i ludzie dostają deterministyczne fakty o repozytorium Java z `plik:linia`; model jest wystarczająco bogaty dla późniejszego planu portowania (typy z członkami, encje z relacjami, endpointy z typami, wiązania beanów, klucze konfiguracji).
- Dwa pliki WebAssembly więcej w zasobach aplikacji i paczki Linux; brak ich psuje tylko komendy `java`.
- Indeks importów jest przebudowywany raz (nowy klucz `oxc/1+java/1`); repozytorium z Javą ma w grafie pliki `.java` i moduły jako pakiety.
- Czytanie przez tokenizer i przez parser to dwie drogi do tych samych importów; test kontraktowy i e2e pilnują, żeby graf i model mówiły to samo.
- Ograniczenia: rozwiązywanie nazw jest przybliżone (bez pełnej semantyki Javy: dziedziczone typy zagnieżdżone, importy statyczne członków typów); adnotacje rozpoznawane po prostej nazwie; DSL routera i ścieżki ze stałych są `likely`; Gradle czytany wzorcami (skrypty to kod); pamięć przy ~30 tys. plików ~2–3 GB.

## Alternatywy odrzucone
- **`java-parser`** (czysty JavaScript): parsuje cały korpus, ale jest trzy razy wolniejszy, zużywa ośmiokrotnie więcej pamięci i rzuca wyjątkiem na pierwszym błędzie składni (plik przepada w całości).
- **`javac`/JVM** (np. JavaParser w Javie): wymaga JDK tam, gdzie czytamy; zakazane przez kontrakt rundy.
- **Natywny `tree-sitter` (napi)**: kolejny dodatek natywny na platformę (jak oxc), bez zysku nad WebAssembly przy tej skali.
- **Port `prepare()` na `ImportAnalyzer`**: szósty członek portu (MT-ARCH-008) i asynchroniczna inicjalizacja w każdej komendzie grafu; zastąpione tokenizerem dla importów.
