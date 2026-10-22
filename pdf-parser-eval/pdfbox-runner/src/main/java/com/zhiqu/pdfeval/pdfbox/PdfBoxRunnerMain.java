package com.zhiqu.pdfeval.pdfbox;

import com.zhiqu.pdfeval.runner.RunnerSupport;

public final class PdfBoxRunnerMain {
    private PdfBoxRunnerMain() {}

    public static void main(String[] args) throws Exception {
        RunnerSupport.serve("PDFBOX", "3.0.1", new PdfBoxParser(), null);
    }
}
