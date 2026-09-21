package com.zhiqu;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
@MapperScan("com.zhiqu.mapper")
public class ZhiquApplication {
    public static void main(String[] args) {
        SpringApplication.run(ZhiquApplication.class, args);
    }
}
