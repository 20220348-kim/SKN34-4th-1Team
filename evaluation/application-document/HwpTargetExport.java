import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Export Core's actual hwplib target contract for an offline mapping evaluation. */
public class HwpTargetExport {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: HwpTargetExport <official-source.hwp> <new-targets.json>");
        var output = Path.of(args[1]);
        if (Files.exists(output)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(Path.of(args[0]));
        var hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(source));
        var targets = new ApplicationDocumentEditor().inspect(source, "hwp").getTargets();
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        Files.writeString(output, mapper.writeValueAsString(Map.of("sourceSha256", hash, "targets", targets)));
        System.out.println("source=" + hash + " targetCount=" + targets.size());
    }
}
