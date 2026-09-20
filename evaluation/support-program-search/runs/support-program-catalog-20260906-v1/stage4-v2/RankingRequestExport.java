import ai.govbiz.core.CoreApiApplication;
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramRankingRequest;
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper;
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram;
import ai.govbiz.core.supportprogram.domain.SupportProgram;
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus;
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver;
import ai.govbiz.core.supportprogram.facade.AiSupportProgramRankingFacade;
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper;
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import javax.sql.DataSource;
import org.springframework.boot.SpringApplication;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Local measurement helper. Reuses compiled Core mapping; never calls retrieval or ranking HTTP. */
public final class RankingRequestExport {
    private static final class Captured extends RuntimeException {
        Captured() { super(null, null, false, false); }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4) {
            throw new IllegalArgumentException("Usage: RankingRequestExport CAPTURE FIXTURE QUERY_SET NEW_OUTPUT_DIRECTORY");
        }
        Path capturePath = Path.of(args[0]).toAbsolutePath();
        Path fixturePath = Path.of(args[1]).toAbsolutePath();
        Path querySetPath = Path.of(args[2]).toAbsolutePath();
        Path outputPath = Path.of(args[3]).toAbsolutePath();
        require(!Files.exists(outputPath), "output directory must not already exist");
        ObjectMapper json = new ObjectMapper();
        JsonNode capture = json.readTree(capturePath);
        JsonNode fixture = json.readTree(fixturePath);
        JsonNode querySet = json.readTree(querySetPath);
        require("support-program-search-capture-v2".equals(text(capture, "schemaVersion")), "unsupported capture");
        require(capture.required("acceptingOnly").booleanValue(), "expected accepting-only capture");
        require(capture.required("catalog").equals(fixture.required("catalog")), "fixture/capture catalog mismatch");
        require(text(capture, "referenceDate").equals(text(fixture, "referenceDate")), "reference date mismatch");
        require(text(capture.required("querySet"), "name").equals(text(fixture, "name")), "fixture name mismatch");
        require(text(querySet, "name").equals(text(fixture, "name")), "query set name mismatch");
        require(capture.at("/search/candidateLimit").intValue() == 20, "expected candidate limit 20");
        require(capture.at("/search/finalResultLimit").intValue() == 5, "expected result limit 5");
        require(text(capture.required("search"), "scoringVersion").equals(AiSupportProgramRankingFacade.SCORING_VERSION), "scoring contract mismatch");
        JsonNode observations = capture.required("observations");
        JsonNode queries = querySet.required("queries");
        require(observations.isArray() && observations.size() > 0 && observations.size() == queries.size(), "query count mismatch");
        List<Map<String, String>> canonicalQueries = new ArrayList<>();
        HashSet<String> queryIds = new HashSet<>();
        for (int i = 0; i < queries.size(); i++) {
            JsonNode query = queries.get(i);
            JsonNode observation = observations.get(i);
            Map<String, String> canonical = new TreeMap<>();
            for (String field : List.of("id", "query", "split")) {
                require(text(query, field).equals(text(observation, field)), "query identity/order mismatch at " + i);
                canonical.put(field, text(query, field));
            }
            require(queryIds.add(text(query, "id")), "duplicate query id");
            canonicalQueries.add(canonical);
        }
        require(sha256(json.writeValueAsBytes(canonicalQueries)).equals(text(capture.required("querySet"), "sha256")), "canonical query hash mismatch");
        LocalDate referenceDate = LocalDate.parse(text(capture, "referenceDate"));
        SpringApplication application = new SpringApplication(CoreApiApplication.class);
        try (var context = application.run(
                "--spring.main.web-application-type=none",
                "--spring.profiles.active=ranking-request-export-local",
                "--spring.flyway.enabled=false",
                "--spring.sql.init.mode=never",
                "--app.bizinfo.sync.enabled=false",
                "--app.support-program-index.enabled=false",
                "--spring.datasource.hikari.read-only=true",
                "--spring.datasource.hikari.connection-init-sql=SET SESSION TRANSACTION READ ONLY",
                "--spring.datasource.hikari.maximum-pool-size=1",
                "--spring.main.banner-mode=off",
                "--logging.level.root=WARN")) {
            ObjectMapper mapper = context.getBean(ObjectMapper.class);
            try (var connection = context.getBean(DataSource.class).getConnection();
                 var statement = connection.createStatement();
                 var rows = statement.executeQuery("SELECT @@session.transaction_read_only")) {
                require(connection.isReadOnly(), "JDBC connection must be read-only");
                require(rows.next() && rows.getInt(1) == 1, "MySQL session must be transaction read-only");
            }
            List<CatalogSupportProgram> present = context.getBean(SupportProgramRepository.class).findPresent();
            List<CatalogSupportProgram> eligible = present.stream()
                    .map(item -> atDate(item, referenceDate))
                    .filter(item -> item.getProgram().getStatus() == SupportProgramStatus.OPEN)
                    .toList();
            require(present.size() == capture.at("/catalog/presentProgramCount").intValue(), "present count changed");
            require(eligible.size() == capture.at("/catalog/eligibleProgramCount").intValue(), "eligible count changed");
            String fingerprint = SupportProgramCatalogFingerprintHelper.INSTANCE.calculate(eligible);
            require(fingerprint.equals(capture.at("/catalog/eligibleCatalogFingerprint").stringValue()), "eligible catalog fingerprint changed");
            Map<String, JsonNode> fixtureDocs = new HashMap<>();
            for (JsonNode doc : fixture.required("docs")) {
                require(fixtureDocs.put(text(doc, "id"), doc) == null, "duplicate fixture id");
            }
            require(fixtureDocs.size() == eligible.size(), "fixture document count mismatch");
            Map<String, CatalogSupportProgram> byId = new HashMap<>();
            for (CatalogSupportProgram item : eligible) {
                var document = SupportProgramIndexDocumentMapper.INSTANCE.fromCatalog(item);
                JsonNode frozen = fixtureDocs.get(document.getId());
                require(frozen != null, "current eligible document absent from fixture: " + document.getId());
                require(text(frozen, "text").equals(document.getText()), "document text changed: " + document.getId());
                require(text(frozen, "contentHash").equals(document.getContentHash()), "document hash changed: " + document.getId());
                require(text(frozen, "sortTimestamp").equals(item.getSortTimestamp()), "sort timestamp changed: " + document.getId());
                require(byId.put(document.getId(), item) == null, "duplicate database id");
            }
            List<Map<String, Object>> requests = new ArrayList<>();
            HashSet<String> uniqueCandidates = new HashSet<>();
            int candidatePairs = 0;
            for (JsonNode observation : observations) {
                List<CatalogSupportProgram> ordered = new ArrayList<>();
                List<String> candidateIds = new ArrayList<>();
                for (JsonNode id : observation.required("candidateIds")) {
                    String value = id.stringValue();
                    require(byId.containsKey(value), "captured candidate missing from validated catalog: " + value);
                    candidateIds.add(value);
                    ordered.add(byId.get(value));
                }
                require(!ordered.isEmpty() && ordered.size() <= 20, "invalid captured candidate count");
                require(new HashSet<>(candidateIds).size() == candidateIds.size(), "duplicate captured candidate");
                AiSupportProgramRankingRequest[] capturedRequest = new AiSupportProgramRankingRequest[1];
                var facade = new AiSupportProgramRankingFacade(request -> {
                    require(capturedRequest[0] == null, "ranking mapper invoked twice");
                    capturedRequest[0] = request;
                    throw new Captured();
                });
                try {
                    facade.rank(text(observation, "query"), List.copyOf(ordered), 5);
                    throw new IllegalStateException("capture-only client was not called");
                } catch (Captured expected) {
                    require(capturedRequest[0] != null, "ranking request was not captured");
                }
                var request = capturedRequest[0];
                require(request.getCandidates().stream().map(candidate -> candidate.getId()).toList().equals(candidateIds), "request candidate order changed");
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", text(observation, "id"));
                row.put("query", text(observation, "query"));
                row.put("split", text(observation, "split"));
                row.put("candidateIds", List.copyOf(candidateIds));
                row.put("coreSerializedRequestSha256", sha256(mapper.writeValueAsBytes(request)));
                row.put("request", request);
                requests.add(row);
                uniqueCandidates.addAll(candidateIds);
                candidatePairs += candidateIds.size();
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("schemaVersion", "support-program-ranking-replay-input-v1");
            payload.put("referenceDate", referenceDate.toString());
            payload.put("catalog", capture.required("catalog"));
            payload.put("querySet", capture.required("querySet"));
            payload.put("sourceCaptureSha256", sha256(Files.readAllBytes(capturePath)));
            payload.put("queries", requests);
            byte[] requestBytes = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(payload);
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("schemaVersion", "support-program-ranking-replay-export-v1");
            metadata.put("status", "succeeded");
            metadata.put("exportedAt", Instant.now().toString());
            metadata.put("inputProvenance", "Current local MySQL repository values validated against the frozen index snapshot; existing compiled Core facade creates requests in captured candidate order.");
            metadata.put("limitation", "This is a snapshot-validated reconstruction, not a stored historical HTTP request. Index text/hash does not prove the original structured field boundaries.");
            metadata.put("referenceDate", referenceDate.toString());
            metadata.put("catalog", capture.required("catalog"));
            metadata.put("queryCount", requests.size());
            metadata.put("candidatePairCount", candidatePairs);
            metadata.put("uniqueCandidateCount", uniqueCandidates.size());
            metadata.put("validation", List.of("MySQL/JDBC read-only session", "present/eligible counts", "full eligible fingerprint", "every fixture document text/hash/sort timestamp", "query name/hash/identity/order", "candidate identity/order", "existing Core facade request mapping"));
            metadata.put("externalApiCalls", 0);
            metadata.put("sourceHashes", Map.of(
                    "captureSha256", sha256(Files.readAllBytes(capturePath)),
                    "fixtureSha256", sha256(Files.readAllBytes(fixturePath)),
                    "querySetFileSha256", sha256(Files.readAllBytes(querySetPath)),
                    "requestFileSha256", sha256(requestBytes),
                    "rankingFacadeClassSha256", classHash(AiSupportProgramRankingFacade.class),
                    "indexDocumentMapperClassSha256", classHash(SupportProgramIndexDocumentMapper.class),
                    "repositoryClassSha256", classHash(SupportProgramRepository.class),
                    "statusResolverClassSha256", classHash(SupportProgramStatusResolver.class),
                    "exporterClassSha256", classHash(RankingRequestExport.class)));
            byte[] metadataBytes = mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(metadata);
            Files.createDirectory(outputPath);
            Files.write(outputPath.resolve("requests.json"), requestBytes, StandardOpenOption.CREATE_NEW);
            Files.write(outputPath.resolve("metadata.json"), metadataBytes, StandardOpenOption.CREATE_NEW);
            System.out.println("Exported " + requests.size() + " requests / " + candidatePairs + " candidate pairs to " + outputPath);
        }
    }

    private static CatalogSupportProgram atDate(CatalogSupportProgram item, LocalDate date) {
        SupportProgram p = item.getProgram();
        SupportProgramStatus status = SupportProgramStatusResolver.INSTANCE.resolve(
                p.getApplicationPeriod(), p.getApplicationStartDate(), p.getApplicationEndDate(), date);
        return item.copy(p.copy(p.getId(), p.getSourceCode(), p.getTitle(), p.getOrganization(), p.getSummary(),
                p.getCategories(), p.getRegions(), p.getTargetDescription(), p.getApplicationPeriod(),
                p.getApplicationStartDate(), p.getApplicationEndDate(), status, p.getSourceName(), p.getSourceUrl(),
                p.getMatchedReasons(), p.getRecommendationScore()), item.getSortTimestamp());
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.required(field);
        require(value.isString(), "expected text field: " + field);
        return value.stringValue();
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static String classHash(Class<?> type) throws Exception {
        try (var stream = type.getResourceAsStream("/" + type.getName().replace('.', '/') + ".class")) {
            require(stream != null, "compiled class resource missing");
            return sha256(stream.readAllBytes());
        }
    }
}
