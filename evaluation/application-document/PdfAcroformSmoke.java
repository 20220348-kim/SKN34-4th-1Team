import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationPayload;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Core PDFBox continuation of the scored EPA AcroForm Mapping and staged WritePlan. */
public class PdfAcroformSmoke {
    private static final String SOURCE_SHA256 = "0cb27836b74d5f469e4ddac81fd294555516ed529b9a8d7b49ee816fa7d9a89c";
    private static final List<ApplicationDocumentFact> FACTS = List.of(
        new ApplicationDocumentFact("representative:first-name", "First Name", "TEST"),
        new ApplicationDocumentFact("representative:last-name", "Last Name", "REPRESENTATIVE"),
        new ApplicationDocumentFact("representative:title", "Title", "TEST DIRECTOR"),
        new ApplicationDocumentFact("representative:phone", "Phone Number", "000-000-0000"),
        new ApplicationDocumentFact("representative:email", "E-mail Address", "test@example.invalid")
    );

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("Usage: PdfAcroformSmoke <source.pdf> <stage.json> <new-output.pdf>");
        var sourcePath = Path.of(args[0]);
        var outputPath = Path.of(args[2]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        var stage = mapper.readValue(Files.readString(Path.of(args[1])), AiDocumentGenerationPayload.class);
        var valuesById = FACTS.stream().collect(Collectors.toMap(ApplicationDocumentFact::getId, ApplicationDocumentFact::getValue));
        var expectedByName = stage.getPlacements().stream().collect(Collectors.toMap(
            p -> p.getTargetId().substring("pdf-field:".length()), p -> valuesById.get(p.getFactId())));
        if (!SOURCE_SHA256.equals(sha256(source)) || !SOURCE_SHA256.equals(stage.getSourceSha256()) ||
                !"PDFBOX_REQUIRED".equals(stage.getVerification().get("stage")) || stage.getPlacements().size() != FACTS.size() ||
                stage.getPlacements().stream().anyMatch(p -> !p.getTargetId().startsWith("pdf-field:") || p.getBox() != null)) {
            throw new IllegalStateException("Official source or native PDF_FIELD stage mismatch");
        }
        Map<String, String> before;
        try (var original = Loader.loadPDF(source)) {
            if (original.getNumberOfPages() != 2 || original.getDocumentCatalog().getAcroForm().hasXFA()) {
                throw new IllegalStateException("Unexpected source PDF structure");
            }
            before = new HashMap<>();
            for (var field : original.getDocumentCatalog().getAcroForm().getFieldTree()) {
                before.put(field.getFullyQualifiedName(), java.util.Objects.toString(field.getValueAsString(), ""));
            }
            if (before.size() != 60) throw new IllegalStateException("Expected 60 original AcroForm fields");
        }
        var output = new ApplicationDocumentEditor().fill(source, "pdf", FACTS, stage.getPlacements(), List.of());
        try (var reopened = Loader.loadPDF(output)) {
            var fields = new java.util.ArrayList<org.apache.pdfbox.pdmodel.interactive.form.PDField>();
            for (var field : reopened.getDocumentCatalog().getAcroForm().getFieldTree()) fields.add(field);
            if (reopened.getNumberOfPages() != 2 || fields.size() != before.size()) {
                throw new IllegalStateException("Page or field count changed");
            }
            for (var field : fields) {
                var name = field.getFullyQualifiedName();
                var expected = expectedByName.getOrDefault(name, before.get(name));
                if (!expected.equals(java.util.Objects.toString(field.getValueAsString(), ""))) throw new IllegalStateException("Unexpected field change: " + name);
                if (expectedByName.containsKey(name)) {
                    var text = (PDTextField) field;
                    if (text.getWidgets().size() != 1 || text.getWidgets().get(0).getAppearance().getNormalAppearance() == null) {
                        throw new IllegalStateException("Missing editable widget appearance: " + name);
                    }
                }
            }
        }
        if (!SOURCE_SHA256.equals(sha256(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Original changed");
        Files.write(outputPath, output);
        System.out.println("AcroForm source=" + SOURCE_SHA256 + " fields=60 requested=5 verified=5 unchangedFields=55 pages=2 output=" + sha256(output));
    }
}
