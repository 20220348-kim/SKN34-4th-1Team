import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationPayload;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.stream.Collectors;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Reproduces Core inspect/write on the Customs Service hosted official AcroForm. */
public class PdfKoreanOfficialSmoke {
    private static final String SOURCE_SHA256 = "dceb9ad371a121dcde82c408f511a23c14518a81af334be15965bd53829d52cf";
    private static final List<ApplicationDocumentFact> FACTS = List.of(
        new ApplicationDocumentFact("producer:company", "1 Company Full Name 1", "TEST-PRODUCER"),
        new ApplicationDocumentFact("seller:company", "1 Company Full Name", "TEST-SELLER"),
        new ApplicationDocumentFact("importer:company", "1 Company Full Name_2", "TEST-IMPORTER"),
        new ApplicationDocumentFact("official:name", "1 Full Name of the Official", "TEST-OFFICIAL"),
        new ApplicationDocumentFact("seller:present", "Seller or Trader?", "1")
    );

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if ((args[0].equals("inspect") && args.length != 3) || (args[0].equals("write") && args.length != 4)) {
            throw new IllegalArgumentException("Usage: PdfKoreanOfficialSmoke inspect <source.pdf> <request.json> | write <source.pdf> <stage.json> <output.pdf>");
        }
        var sourcePath = Path.of(args[1]);
        var outputPath = Path.of(args[args.length - 1]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        if (!SOURCE_SHA256.equals(sha256(source))) throw new IllegalArgumentException("Official source SHA-256 mismatch");
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        if (args[0].equals("inspect")) {
            var inspection = new ApplicationDocumentEditor().inspect(source, "pdf");
            if (inspection.getPageImages().size() != 1 || inspection.getPdfFields().size() != 42) {
                throw new IllegalStateException("Unexpected AcroForm structure");
            }
            var request = Map.of("contractVersion", "application-document-mcp-v1",
                "sourceBase64", Base64.getEncoder().encodeToString(source), "sourceSha256", SOURCE_SHA256,
                "format", "pdf", "answerRevision", 1, "facts", FACTS,
                "scope", "Producer/Exporter Certificate", "pdfTargets", inspection.getTargets(),
                "pageImages", inspection.getPageImages(), "pdfFields", inspection.getPdfFields());
            Files.writeString(outputPath, mapper.writeValueAsString(request));
            System.out.println("Core inspect: pages=1 fields=42 targets=" + inspection.getTargets().size());
            return;
        }
        var stage = mapper.readValue(Files.readString(Path.of(args[2])), AiDocumentGenerationPayload.class);
        var expected = FACTS.stream().collect(Collectors.toMap(ApplicationDocumentFact::getId, ApplicationDocumentFact::getValue));
        if (!SOURCE_SHA256.equals(stage.getSourceSha256()) || !"PDFBOX_REQUIRED".equals(stage.getVerification().get("stage")) ||
            stage.getPlacements().size() != FACTS.size() || stage.getPlacements().stream().anyMatch(p ->
                !p.getTargetId().startsWith("pdf-field:") || p.getBox() != null || !expected.containsKey(p.getFactId()))) {
            throw new IllegalStateException("Unexpected native PDF write plan");
        }
        Map<String, String> before = new HashMap<>();
        try (var original = Loader.loadPDF(source)) {
            for (var field : original.getDocumentCatalog().getAcroForm().getFieldTree()) {
                before.put(field.getFullyQualifiedName(), field.getValueAsString());
            }
            if (original.getNumberOfPages() != 1 || before.size() != 42) throw new IllegalStateException("Source changed");
        }
        var output = new ApplicationDocumentEditor().fill(source, "pdf", FACTS, stage.getPlacements(), List.of());
        var expectedByName = stage.getPlacements().stream().collect(Collectors.toMap(
            p -> p.getTargetId().substring("pdf-field:".length()), p -> expected.get(p.getFactId())));
        try (var reopened = Loader.loadPDF(output)) {
            var form = reopened.getDocumentCatalog().getAcroForm();
            int count = 0;
            for (var field : form.getFieldTree()) {
                count++;
                var name = field.getFullyQualifiedName();
                var value = expectedByName.getOrDefault(name, before.get(name));
                var savedValue = field instanceof PDRadioButton radioField
                    ? radioField.getCOSObject().getNameAsString(COSName.V) : field.getValueAsString();
                if (!value.equals(savedValue)) throw new IllegalStateException("Unexpected value: " + name);
                if (expectedByName.containsKey(name)) for (var widget : ((org.apache.pdfbox.pdmodel.interactive.form.PDTerminalField)field).getWidgets()) {
                    if (widget.getAppearance() == null || widget.getAppearance().getNormalAppearance() == null) {
                        throw new IllegalStateException("Missing appearance: " + name);
                    }
                }
            }
            var radio = (PDRadioButton) form.getField("Seller or Trader?");
            System.out.println("Radio reopened: fields=" + count + " pages=" + reopened.getNumberOfPages()
                + " rawValue=" + radio.getCOSObject().getNameAsString(COSName.V)
                + " states=" + radio.getWidgets().stream().map(w -> w.getAppearanceState().getName()).toList());
            if (count != 42 || reopened.getNumberOfPages() != 1 ||
                !"1".equals(radio.getCOSObject().getNameAsString(COSName.V)) ||
                !"Off".equals(radio.getWidgets().get(0).getAppearanceState().getName()) ||
                !"1".equals(radio.getWidgets().get(1).getAppearanceState().getName())) {
                throw new IllegalStateException("Radio group or page structure changed");
            }
        }
        if (!SOURCE_SHA256.equals(sha256(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Source modified");
        Files.write(outputPath, output);
        System.out.println("Core write: fields=42 changed=5 unchanged=37 radioExclusive=true output=" + sha256(output));
    }
}
