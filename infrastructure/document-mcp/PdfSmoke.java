import ai.govbiz.core.applicationpreparation.domain.*;
import ai.govbiz.core.applicationpreparation.client.ai.dto.*;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.*;
import java.util.*;
import java.security.MessageDigest;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;
import org.apache.pdfbox.rendering.PDFRenderer;
import javax.imageio.ImageIO;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.module.kotlin.KotlinModule;

/** Manual fixture smoke only. Run against the built Core jar; never a public file endpoint. */
public class PdfSmoke {
    public static void main(String[] args) throws Exception {
        var mapper = JsonMapper.builder().addModule(new KotlinModule.Builder().build()).build();
        var editor = new ApplicationDocumentEditor();
        var source = Files.readAllBytes(Path.of(args[1]));
        var output = Path.of(args[2]);
        if (Files.exists(output)) throw new IllegalArgumentException("Output already exists");
        if (args[0].equals("inspect")) {
            var inspection = editor.inspect(source, "pdf");
            var hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(source));
            var request = new AiDocumentGenerationRequest("application-document-mcp-v1", Base64.getEncoder().encodeToString(source),
                hash, "pdf", 1, List.of(new ApplicationDocumentFact("company:name", "기업명", "가상기업")),
                "사람이 확인한 기업지원 신청서 첫 페이지의 기업명 입력란", inspection.getTargets(), inspection.getPageImages(), List.of(), List.of(), inspection.getPdfFields(), List.of());
            Files.writeString(output, mapper.writeValueAsString(request));
            System.out.println("Core inspection pages=" + inspection.getPageImages().size());
        } else if (args[0].equals("fill")) {
            var response = mapper.readValue(Files.readString(Path.of(args[3])), AiDocumentGenerationPayload.class);
            if (!response.getVerification().get("stage").equals("PDFBOX_REQUIRED")) throw new IllegalArgumentException("Wrong stage");
            var facts = List.of(new ApplicationDocumentFact("company:name", "기업명", "가상기업"));
            var filled = editor.fill(source, "pdf", facts, response.getPlacements(), List.of());
            Files.write(output, filled);
            try (var doc = Loader.loadPDF(filled)) {
                ImageIO.write(new PDFRenderer(doc).renderImage(0, 1.5f), "png", Path.of(args[2] + ".png").toFile());
                var field = (PDTextField) doc.getDocumentCatalog().getAcroForm().getFields().getFirst();
                if (!field.getValue().equals("가상기업")) throw new IllegalStateException("Value mismatch");
                field.setValue("수정한 가상기업");
                var edited = Path.of(args[2] + ".reedited.pdf");
                if (Files.exists(edited)) throw new IllegalArgumentException("Edited output already exists");
                doc.save(edited.toFile());
                try (var reopened = Loader.loadPDF(edited.toFile())) {
                    if (!reopened.getDocumentCatalog().getAcroForm().getFields().getFirst().getValueAsString().equals("수정한 가상기업"))
                        throw new IllegalStateException("Re-edit verification failed");
                }
            }
            System.out.println("PDFBox fill, appearance render, re-edit/save/reopen passed");
        } else throw new IllegalArgumentException("Use inspect or fill");
    }
}
