import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationPayload;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Core PDFBox continuation of the scored production PDF_INPUT Mapping and staged WritePlan. */
public class PdfMappedSmoke {
    private static final String SOURCE_SHA256 = "4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3";
    private static final List<ApplicationDocumentFact> FACTS = List.of(
        new ApplicationDocumentFact("company:name", "기 업 명", "TEST-COMPANY"),
        new ApplicationDocumentFact("company:representative", "대 표 자 명", "TEST-REP"),
        new ApplicationDocumentFact("company:2026-support-sales", "지원사업으로 인한 매출액", "100"),
        new ApplicationDocumentFact("company:2026-employees", "기업 총 고용인원", "10"),
        new ApplicationDocumentFact("company:2026-new-employees", "지원사업으로 인한 신규고용", "2")
    );

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("Usage: PdfMappedSmoke <source.pdf> <stage.json> <new-output.pdf>");
        var sourcePath = Path.of(args[0]);
        var outputPath = Path.of(args[2]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        var stage = mapper.readValue(Files.readString(Path.of(args[1])), AiDocumentGenerationPayload.class);
        if (!SOURCE_SHA256.equals(sha256(source)) || !SOURCE_SHA256.equals(stage.getSourceSha256()) ||
                !"PDFBOX_REQUIRED".equals(stage.getVerification().get("stage")) ||
                stage.getPlacements().size() != FACTS.size() ||
                !stage.getPlacements().stream().map(p -> p.getFactId()).collect(Collectors.toSet()).equals(
                    FACTS.stream().map(ApplicationDocumentFact::getId).collect(Collectors.toSet()))) {
            throw new IllegalStateException("PDF stage, source, or placement mismatch");
        }
        for (var placement : stage.getPlacements()) {
            var expectedPage = placement.getFactId().startsWith("company:2026-") ? "page-5" : "page-1";
            if (!expectedPage.equals(placement.getTargetId()) || placement.getBox() == null) {
                throw new IllegalStateException("PDF placement page or box mismatch");
            }
        }
        var output = new ApplicationDocumentEditor().fill(source, "pdf", FACTS, stage.getPlacements(), List.of());
        try (var reopened = Loader.loadPDF(output)) {
            var form = reopened.getDocumentCatalog().getAcroForm();
            var fields = form.getFields();
            Map<String, String> values = FACTS.stream().collect(Collectors.toMap(ApplicationDocumentFact::getLabel,
                ApplicationDocumentFact::getValue));
            if (reopened.getNumberOfPages() != 11 || fields.size() != FACTS.size()) {
                throw new IllegalStateException("PDF page or field count mismatch");
            }
            for (var field : fields) {
                if (!(field instanceof PDTextField text) ||
                        !values.getOrDefault(text.getAlternateFieldName(), "").equals(text.getValue()) ||
                        text.getWidgets().size() != 1 ||
                        text.getWidgets().get(0).getAppearance().getNormalAppearance() == null) {
                    throw new IllegalStateException("PDF field value, widget, or appearance mismatch");
                }
            }
        }
        if (!SOURCE_SHA256.equals(sha256(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Original changed");
        Files.write(outputPath, output);
        System.out.println("PDF source=" + SOURCE_SHA256 + " requested=" + FACTS.size() +
            " verified=" + FACTS.size() + " pages=11 originalPreserved=true output=" + sha256(output));
    }
}
