import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentEditOperation;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentTarget;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentWritePlan;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Manual verification of one official, unmodified HWP application. Run with Core's runtime classpath. */
public class HwpSmoke {
    private record Field(String id, String label, String labelTarget, String inputTarget, String value) {}

    private static final String SOURCE_SHA256 = "8a90cf4d5d8bcb54d48203847d9f54c47efad7935e31ced4a8bd08e090f2a465";
    private static final List<Field> FIELDS = List.of(
        new Field("company:name", "기 업 명", "s0-p0-t0-r3-c1-p0", "s0-p0-t0-r3-c2-p0", "TEST-COMPANY"),
        new Field("company:representative", "대표자", "s0-p0-t0-r3-c3-p0", "s0-p0-t0-r3-c4-p0", "TEST-REPRESENTATIVE"),
        new Field("company:registration", "사업자등록번호", "s0-p0-t0-r4-c0-p0", "s0-p0-t0-r4-c1-p0", "000-00-00000"),
        new Field("company:homepage", "홈 페 이 지", "s0-p0-t0-r9-c0-p0", "s0-p0-t0-r9-c1-p0", "https://example.invalid"),
        new Field("company:headquarters", "본사", "s0-p0-t0-r10-c1-p0", "s0-p0-t0-r10-c2-p0", "TEST-ADDRESS"),
        new Field("company:product", "주요제품", "s0-p0-t0-r13-c0-p0", "s0-p0-t0-r13-c1-p0", "TEST-PRODUCT"),
        new Field("contact:phone", "사무실전화", "s0-p0-t0-r15-c0-p0", "s0-p0-t0-r15-c1-p0", "000-0000-0000"),
        new Field("contact:email", "전자메일", "s0-p0-t0-r16-c2-p0", "s0-p0-t0-r16-c3-p0", "test@example.invalid")
    );

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: HwpSmoke <official-source.hwp> <new-output.hwp>");
        var sourcePath = Path.of(args[0]);
        var outputPath = Path.of(args[1]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        if (!SOURCE_SHA256.equals(sha256(source))) throw new IllegalArgumentException("Official source SHA-256 mismatch");
        var editor = new ApplicationDocumentEditor();
        var before = editor.inspect(source, "hwp").getTargets();
        Map<String, ApplicationDocumentTarget> byId = before.stream().collect(Collectors.toMap(ApplicationDocumentTarget::getId, Function.identity()));
        var facts = new ArrayList<ApplicationDocumentFact>();
        var operations = new ArrayList<ApplicationDocumentEditOperation>();
        var bindings = new ArrayList<ApplicationDocumentPlacement>();
        var scope = new ArrayList<String>();
        for (var field : FIELDS) {
            var label = byId.get(field.labelTarget());
            var input = byId.get(field.inputTarget());
            if (label == null || input == null || !label.getText().strip().equals(field.label()) ||
                    !input.getText().isEmpty() || !input.getEditable()) {
                throw new IllegalStateException("Ground Truth label or blank target changed: " + field.id());
            }
            facts.add(new ApplicationDocumentFact(field.id(), field.label(), field.value()));
            operations.add(new ApplicationDocumentEditOperation(input.getId(), "input", "", 0, 0, field.id(), null,
                "Human-reviewed adjacent official blank cell", "preserve"));
            bindings.add(new ApplicationDocumentPlacement(field.id(), input.getId(), null));
            scope.add(input.getId());
        }
        var plan = new ApplicationDocumentWritePlan(SOURCE_SHA256, "native-map-v12-hwpx-context-budget", 1L,
            "0".repeat(64), operations, List.of(), scope);
        var output = editor.applyHwpPlan(source, facts, plan, bindings, scope);
        var after = editor.inspect(output, "hwp").getTargets();
        if (before.size() != after.size()) throw new IllegalStateException("Target count changed");
        var values = FIELDS.stream().collect(Collectors.toMap(Field::inputTarget, Field::value));
        for (int i = 0; i < before.size(); i++) {
            var oldTarget = before.get(i);
            var newTarget = after.get(i);
            if (!oldTarget.getId().equals(newTarget.getId()) ||
                    !newTarget.getText().equals(values.getOrDefault(oldTarget.getId(), oldTarget.getText()))) {
                throw new IllegalStateException("Unexpected target change: " + oldTarget.getId());
            }
        }
        if (!SOURCE_SHA256.equals(sha256(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Original changed");
        Files.write(outputPath, output);
        System.out.println("HWP source=" + SOURCE_SHA256 + " targets=" + before.size() + " requested=" + FIELDS.size()
            + " applied=" + FIELDS.size() + " verified=" + FIELDS.size() + " unexpectedTextChanges=0 output=" + sha256(output));
    }
}
