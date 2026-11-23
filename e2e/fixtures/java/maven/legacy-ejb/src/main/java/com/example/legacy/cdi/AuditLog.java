package com.example.legacy.cdi;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Named;

@ApplicationScoped
@Named("audit")
public class AuditLog {
  public void record(String what) {
    System.out.println("audit: " + what);
  }
}
