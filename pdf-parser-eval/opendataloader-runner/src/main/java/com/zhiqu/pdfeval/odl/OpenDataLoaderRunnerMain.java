package com.zhiqu.pdfeval.odl;

import com.zhiqu.pdfeval.runner.RunnerSupport;
import org.opendataloader.pdf.api.OpenDataLoaderPDF;

public final class OpenDataLoaderRunnerMain {
    private OpenDataLoaderRunnerMain() {}

    public static void main(String[] args) throws Exception {
        RunnerSupport.serve("OPENDATALOADER", "2.4.7", new OpenDataLoaderParser(), OpenDataLoaderPDF::shutdown);
    }
}
