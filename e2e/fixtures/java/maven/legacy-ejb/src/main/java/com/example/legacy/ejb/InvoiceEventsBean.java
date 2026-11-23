package com.example.legacy.ejb;

import jakarta.ejb.ActivationConfigProperty;
import jakarta.ejb.MessageDriven;

@MessageDriven(
    activationConfig = {
      @ActivationConfigProperty(propertyName = "destinationLookup", propertyValue = "jms/invoices"),
      @ActivationConfigProperty(propertyName = "destinationType", propertyValue = "jakarta.jms.Queue")
    })
public class InvoiceEventsBean {
  public void onMessage(Object message) {
    System.out.println(message);
  }
}
