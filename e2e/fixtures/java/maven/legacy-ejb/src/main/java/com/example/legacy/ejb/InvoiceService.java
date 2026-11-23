package com.example.legacy.ejb;

import com.example.legacy.cdi.AuditLog;
import com.example.legacy.model.Invoice;
import jakarta.ejb.Stateless;
import jakarta.inject.Inject;
import java.util.ArrayList;
import java.util.List;

@Stateless
public class InvoiceService {
  @Inject
  private AuditLog audit;

  private final List<Invoice> store = new ArrayList<>();

  public Invoice find(long id) {
    audit.record("find " + id);
    return store.stream().filter(i -> i.getId() == id).findFirst().orElse(null);
  }

  public List<Invoice> byCustomer(String customer) {
    return store.stream().filter(i -> customer == null || customer.equals(i.getCustomer())).toList();
  }

  public void save(Invoice invoice) {
    store.add(invoice);
  }
}
