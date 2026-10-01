package com.zhiqu;

import com.zhiqu.common.ProcessTimeZone;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@MapperScan("com.zhiqu.mapper")
public class ZhiquApplication {
    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(ZhiquApplication.class);
        // 进程默认时区 = 业务时区，在任何 bean、数据库连接之前（见 ProcessTimeZone）
        app.addListeners(new ProcessTimeZone());
        app.run(args);
    }
}
