import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentBox;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFact;
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentPlacement;
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentEditor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField;

/** Manually measured downstream PDFBox smoke; does not evaluate FFDetr or Mapping. */
public class PdfCoreSmoke {
    private static final String SOURCE_SHA256 = "4c90df4a5282dd62ae550bb1676766a550089dce7509192008feee988b24bde3";

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) throw new IllegalArgumentException("Usage: PdfCoreSmoke <official-source.pdf> <new-output.pdf>");
        var sourcePath = Path.of(args[0]);
        var outputPath = Path.of(args[1]);
        if (Files.exists(outputPath)) throw new IllegalArgumentException("Output already exists");
        var source = Files.readAllBytes(sourcePath);
        if (!SOURCE_SHA256.equals(sha256(source))) throw new IllegalArgumentException("Official source SHA-256 mismatch");
        var editor = new ApplicationDocumentEditor();
        var inspection = editor.inspect(source, "pdf");
        if (inspection.getPageImages().size() != 11 || !inspection.getPdfFields().isEmpty()) {
            throw new IllegalStateException("Unexpected PDF structure");
        }
        // Page 1, company-name blank cell. Measured against a rendered official page, inside the printed table borders.
        var box = new ApplicationDocumentBox(0.270f, 0.125f, 0.210f, 0.026f);
        var output = editor.fill(source, "pdf",
            List.of(new ApplicationDocumentFact("company:name", "기업명", "TEST-COMPANY")),
            List.of(new ApplicationDocumentPlacement("company:name", "page-0", box)), List.of());
        try (var reopened = Loader.loadPDF(output)) {
            var fields = reopened.getDocumentCatalog().getAcroForm().getFields();
            if (reopened.getNumberOfPages() != 11 || fields.size() != 1 ||
                    !(fields.get(0) instanceof PDTextField field) || !"TEST-COMPANY".equals(field.getValue()) ||
                    field.getWidgets().size() != 1 || field.getWidgets().get(0).getAppearance().getNormalAppearance() == null) {
                throw new IllegalStateException("PDFBox field, widget, appearance, or page count mismatch");
            }
        }
        if (!SOURCE_SHA256.equals(sha256(Files.readAllBytes(sourcePath)))) throw new IllegalStateException("Original changed");
        Files.write(outputPath, output);
        System.out.println("PDF source=" + SOURCE_SHA256 + " pages=11 originalFields=0 requested=1 applied=1 verified=1 output=" + sha256(output));
    }
}
