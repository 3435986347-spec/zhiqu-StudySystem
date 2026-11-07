package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;

/** 判据用：不管问哪个账号都给同一份（只关心循环本身、不关心分账号的判据）。分账号的判据用真的 WorkspaceRegistry。 */
public final class SingleAccountRegistry extends WorkspaceRegistry {

    private final WorkspaceService service;
    private final WorkspaceExecutor executor;

    public SingleAccountRegistry(WorkspaceService service, WorkspaceExecutor executor) {
        super(new WorkspaceProperties(), new ObjectMapper(), "unused.json", "127.0.0.1", "");
        this.service = service;
        this.executor = executor;
    }

    @Override
    public WorkspaceService service(Long userId) {
        return service;
    }

    @Override
    public WorkspaceExecutor executor(Long userId) {
        return executor;
    }
}
