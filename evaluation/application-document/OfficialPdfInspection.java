import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Export the real Core PDF inspection for the offline official-form regression. */
public class OfficialPdfInspection {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: OfficialPdfInspection <source.pdf> <new-inspection.json>");
        var output = Path.of(args[1]);
        if (Files.exists(output)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(Path.of(args[0]));
        var inspection = new ApplicationDocumentEditor().inspect(source, "pdf");
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        Files.writeString(output, mapper.writeValueAsString(Map.of(
            "sourceSha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(source)),
            "sourceBase64", Base64.getEncoder().encodeToString(source),
            "pdfTargets", inspection.getTargets(), "pageImages", inspection.getPageImages(),
            "pdfFields", inspection.getPdfFields())));
        System.out.println("pages=" + inspection.getPageImages().size() + " targets=" + inspection.getTargets().size());
    }
}
