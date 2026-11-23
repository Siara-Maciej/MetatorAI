package com.example.legacy.ejb;

import jakarta.annotation.PostConstruct;
import jakarta.ejb.EJB;
import jakarta.ejb.Singleton;
import jakarta.ejb.Startup;

@Singleton
@Startup
public class CacheWarmer {
  @EJB
  private InvoiceService invoices;

  @PostConstruct
  void warm() {
    invoices.byCustomer(null);
  }
}
