package com.example.legacy.spring;

import com.example.legacy.cdi.AuditLog;

/** Wired in applicationContext.xml, the old way. */
public class LegacyAuditService {
  private AuditLog auditLog;
  private String channel;

  public void setAuditLog(AuditLog auditLog) {
    this.auditLog = auditLog;
  }

  public void setChannel(String channel) {
    this.channel = channel;
  }
}
