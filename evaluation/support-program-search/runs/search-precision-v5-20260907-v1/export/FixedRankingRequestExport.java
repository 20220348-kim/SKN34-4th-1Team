import ai.govbiz.core.CoreApiApplication;
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingPayload;
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest;
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRankingFacade;
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRetrievalFacade;
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions;
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository;
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.springframework.boot.SpringApplication;
import tools.jackson.databind.ObjectMapper;

/** One-shot real Core retrieval export. Ranking is captured locally and never sent to an LLM. */
public final class FixedRankingRequestExport {
    private static final String QUERY = "사업화 지원금";
    private static final LocalDate REFERENCE_DATE = LocalDate.of(2026, 9, 7);

    public static void main(String[] args) {
        try {
            export(args);
        } catch (Throwable error) {
            // External failure messages, environment variables and credentials are deliberately not logged.
            System.err.println("Export failed without retry: " + error.getClass().getSimpleName());
            System.exit(1);
        }
    }

    private static void export(String[] args) throws Exception {
        require(args.length == 1, "one new output directory is required");
        Path output = Path.of(args[0]).toAbsolutePath();
        require(!Files.exists(output), "output directory already exists; reruns are forbidden");
        require("govbiz-support-program-ranking-v5".equals(AiSupportProgramRankingFacade.SCORING_VERSION), "requires current Core v5");
        Files.createDirectory(output);
        // Written before context startup or the sole retrieval call so a failed invocation cannot be retried accidentally.
        Files.writeString(output.resolve("attempt-started.txt"), Instant.now() + "\n", StandardOpenOption.CREATE_NEW);
        var application = new SpringApplication(CoreApiApplication.class);
        try (var context = application.run(
                "--spring.main.web-application-type=none",
                "--spring.profiles.active=fixed-ranking-export-local",
                "--spring.flyway.enabled=false",
                "--spring.sql.init.mode=never",
                "--app.bizinfo.sync.enabled=false",
                "--app.support-program-index.enabled=false",
                "--spring.datasource.hikari.read-only=true",
                "--spring.datasource.hikari.connection-init-sql=SET SESSION TRANSACTION READ ONLY",
                "--spring.datasource.hikari.maximum-pool-size=1",
                "--spring.main.banner-mode=off",
                "--spring.main.log-startup-info=false",
                "--logging.level.root=OFF")) {
            ObjectMapper mapper = context.getBean(ObjectMapper.class);
            try (var connection = context.getBean(DataSource.class).getConnection();
                 var statement = connection.createStatement();
                 var rows = statement.executeQuery("SELECT @@session.transaction_read_only")) {
                require(connection.isReadOnly(), "JDBC connection is not read-only");
                require(rows.next() && rows.getInt(1) == 1, "MySQL session is not transaction read-only");
            }
            var conditions = new SupportProgramCompanyConditions("서울", "SW", null, "지원금");
            AiSupportProgramRankingRequest[] captured = new AiSupportProgramRankingRequest[1];
            var captureFacade = new AiSupportProgramRankingFacade(request -> {
                require(captured[0] == null, "ranking capture invoked more than once");
                captured[0] = request;
                return new AiSupportProgramRankingPayload(request.getOriginalQuery(), request.getScoringVersion(), List.of());
            });
            var search = new SupportProgramSearchService(
                context.getBean(SupportProgramRepository.class),
                captureFacade,
                context.getBean(AiSupportProgramRetrievalFacade.class),
                Clock.fixed(REFERENCE_DATE.atStartOfDay(ZoneId.of("Asia/Seoul")).toInstant(), ZoneId.of("Asia/Seoul"))
            );
            var queryBuilder = SupportProgramSearchService.class.getDeclaredMethod(
                "buildRetrievalQuery", String.class, SupportProgramCompanyConditions.class);
            queryBuilder.setAccessible(true);
            String retrievalQuery = (String) queryBuilder.invoke(search, QUERY, conditions);
            require("사업화 지원금\n서울\nSW\n지원금".equals(retrievalQuery), "runtime does not contain the current clean retrieval query");
            // Exactly one real retrieval (one query embedding); no retries, sync, indexing or ranking HTTP calls.
            var trace = search.searchWithTrace(QUERY, true, REFERENCE_DATE, conditions);
            var request = captured[0];
            require(request != null && request.getCandidates().size() == 20, "expected exactly twenty captured candidates");
            require(trace.getCandidateIds().equals(request.getCandidates().stream().map(item -> item.getId()).toList()), "candidate order mismatch");
            require(trace.getFinalProgramIds().isEmpty(), "capture stub must not produce final recommendations");
            require(request.getCompanyConditions() != null && REFERENCE_DATE.toString().equals(request.getCompanyConditions().getReferenceDate()), "condition reference date mismatch");
            byte[] requestBytes = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(request);
            Map<String, Object> traceMetadata = new LinkedHashMap<>();
            traceMetadata.put("query", QUERY);
            traceMetadata.put("referenceDate", REFERENCE_DATE.toString());
            traceMetadata.put("acceptingOnly", true);
            traceMetadata.put("candidateIds", trace.getCandidateIds());
            traceMetadata.put("presentProgramCount", trace.getPresentProgramCount());
            traceMetadata.put("eligibleProgramCount", trace.getEligibleProgramCount());
            traceMetadata.put("eligibleCatalogFingerprint", trace.getEligibleCatalogFingerprint());
            traceMetadata.put("rankingOutput", "Not measured: local capture client returned an empty synthetic ranking.");
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("schemaVersion", "support-program-fixed-ranking-export-v1");
            metadata.put("status", "succeeded");
            metadata.put("exportedAt", Instant.now().toString());
            metadata.put("queryCount", 1);
            metadata.put("candidatePairCount", request.getCandidates().size());
            metadata.put("retrievalCalls", 1);
            metadata.put("expectedEmbeddingCalls", 1);
            metadata.put("externalRankingCalls", 0);
            metadata.put("databaseSessionReadOnlyVerified", true);
            metadata.put("requestFileSha256", sha256(requestBytes));
            metadata.put("coreSerializedRequestSha256", sha256(mapper.writeValueAsBytes(request)));
            metadata.put("retrievalQuery", retrievalQuery);
            metadata.put("sourceHashes", Map.of(
                "rankingFacadeClassSha256", classHash(AiSupportProgramRankingFacade.class),
                "retrievalFacadeClassSha256", classHash(AiSupportProgramRetrievalFacade.class),
                "searchServiceClassSha256", classHash(SupportProgramSearchService.class),
                "repositoryClassSha256", classHash(SupportProgramRepository.class),
                "exporterClassSha256", classHash(FixedRankingRequestExport.class)
            ));
            metadata.put("limitation", "Candidate retrieval is real; final recommendations and precision are not measured by this capture-only export. Embedding usage must be cross-checked against AI service logs.");
            Files.write(output.resolve("request.json"), requestBytes, StandardOpenOption.CREATE_NEW);
            Files.write(output.resolve("trace.json"), mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(traceMetadata), StandardOpenOption.CREATE_NEW);
            Files.write(output.resolve("metadata.json"), mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(metadata), StandardOpenOption.CREATE_NEW);
            System.out.println("Exported 1 query / 20 candidates; ranking API calls: 0; read-only DB verified.");
        }
    }

    private static String classHash(Class<?> type) throws Exception {
        try (var stream = type.getResourceAsStream("/" + type.getName().replace('.', '/') + ".class")) {
            require(stream != null, "compiled class missing");
            return sha256(stream.readAllBytes());
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
