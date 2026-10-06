import ai.govbiz.core.applicationpreparation.client.ai.dto.AiDocumentGenerationPayload;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentWritePlan;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Finish the current AI pipeline's staged HWP/PDF result through the actual Core editor. */
public class OfficialNativeCompletion {
    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("Usage: OfficialNativeCompletion <source> <request.json> <stage.json> <new-output>");
        var sourcePath = Path.of(args[0]);
        var outputPath = Path.of(args[3]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        var request = mapper.readTree(Files.readString(Path.of(args[1])));
        var stage = mapper.readValue(Files.readString(Path.of(args[2])), AiDocumentGenerationPayload.class);
        if (!hash(source).equals(stage.getSourceSha256()) || !hash(source).equals(request.path("sourceSha256").asText()))
            throw new IllegalStateException("Source identity mismatch");
        var format = request.path("format").asText();
        var facts = new ArrayList<ApplicationDocumentFact>();
        for (var fact : request.path("facts")) facts.add(mapper.treeToValue(fact, ApplicationDocumentFact.class));
        var editor = new ApplicationDocumentEditor();
        byte[] completed;
        if (format.equals("hwp") && "HWPLIB_REQUIRED".equals(stage.getVerification().get("stage"))) {
            var bindings = new ArrayList<ApplicationDocumentPlacement>();
            for (var binding : request.path("bindings")) bindings.add(mapper.treeToValue(binding, ApplicationDocumentPlacement.class));
            var scope = new ArrayList<String>();
            for (var target : request.path("scopeTargetIds")) scope.add(target.asText());
            var plan = mapper.convertValue(stage.getWritePlan(), ApplicationDocumentWritePlan.class);
            completed = editor.applyHwpPlan(source, facts, plan, bindings, scope);
            var after = new HashMap<String, String>();
            for (var target : editor.inspect(completed, format).getTargets()) after.put(target.getId(), target.getText());
            var expected = new HashMap<String, String>();
            for (var binding : bindings) expected.put(binding.getTargetId(), facts.stream()
                .filter(fact -> fact.getId().equals(binding.getFactId())).findFirst().orElseThrow().getValue());
            var before = editor.inspect(source, format).getTargets();
            if (before.size() != after.size()) throw new IllegalStateException("HWP target count changed");
            for (var target : before) if (!expected.getOrDefault(target.getId(), target.getText()).equals(after.get(target.getId())))
                throw new IllegalStateException("HWP unexpected target change: " + target.getId());
        } else if (format.equals("pdf") && "PDFBOX_REQUIRED".equals(stage.getVerification().get("stage"))) {
            completed = editor.fill(source, format, facts, stage.getPlacements(), List.of());
            try (var before = Loader.loadPDF(source); var after = Loader.loadPDF(completed)) {
                var fields = after.getDocumentCatalog().getAcroForm().getFields();
                if (before.getNumberOfPages() != after.getNumberOfPages() || fields.size() != facts.size())
                    throw new IllegalStateException("PDF page or field count mismatch");
                Map<String, String> values = new HashMap<>();
                for (var fact : facts) values.put(fact.getLabel(), fact.getValue());
                for (var field : fields) if (!(field instanceof PDTextField text) ||
                        !text.getValue().equals(values.get(text.getAlternateFieldName())) || text.getWidgets().size() != 1 ||
                        text.getWidgets().getFirst().getAppearance().getNormalAppearance() == null)
                    throw new IllegalStateException("PDF value, widget, or appearance mismatch");
            }
        } else throw new IllegalStateException("Unexpected native completion stage");
        if (!hash(source).equals(hash(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Official original changed");
        Files.write(outputPath, completed);
        System.out.println(mapper.writeValueAsString(Map.of("format", format, "sourceSha256", hash(source),
            "outputSha256", hash(completed), "verifiedWrites", facts.size(), "sourcePreserved", true)));
    }
}
