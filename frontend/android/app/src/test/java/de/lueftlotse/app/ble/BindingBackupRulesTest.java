package de.lueftlotse.app.ble;

import java.io.File;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class BindingBackupRulesTest {
    private Document read(String path) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(new File("src/main/" + path));
    }
    private void excludesWebView(Element mode) {
        NodeList rules = mode.getElementsByTagName("exclude"); boolean found = false;
        for (int i = 0; i < rules.getLength(); i++) {
            Element rule = (Element) rules.item(i);
            if (rule.getAttribute("domain").equals("root") && rule.getAttribute("path").equals("app_webview/")) found = true;
        }
        assertTrue("Legacy IndexedDB must not restore into a fresh install", found);
    }
    @Test public void manifestSelectsExclusionsForBothSdkRanges() throws Exception {
        Element app = (Element) read("AndroidManifest.xml").getElementsByTagName("application").item(0);
        String ns = "http://schemas.android.com/apk/res/android";
        assertEquals("@xml/backup_rules", app.getAttributeNS(ns, "fullBackupContent"));
        assertEquals("@xml/data_extraction_rules", app.getAttributeNS(ns, "dataExtractionRules"));
    }
    @Test public void cloudAndDeviceTransferExcludeTheLegacyWebViewStore() throws Exception {
        excludesWebView(read("res/xml/backup_rules.xml").getDocumentElement());
        Document modern = read("res/xml/data_extraction_rules.xml");
        excludesWebView((Element) modern.getElementsByTagName("cloud-backup").item(0));
        excludesWebView((Element) modern.getElementsByTagName("device-transfer").item(0));
    }
}
