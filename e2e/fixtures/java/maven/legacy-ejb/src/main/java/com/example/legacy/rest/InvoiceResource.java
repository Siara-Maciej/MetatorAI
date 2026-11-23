package com.example.legacy.rest;

import com.example.legacy.ejb.InvoiceService;
import com.example.legacy.model.Invoice;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;

@Path("/invoices")
@Produces(MediaType.APPLICATION_JSON)
@RequestScoped
public class InvoiceResource {
  @Inject
  private InvoiceService invoices;

  @GET
  @Path("/{id}")
  public Invoice get(@PathParam("id") long id) {
    return invoices.find(id);
  }

  @GET
  public List<Invoice> search(@QueryParam("customer") String customer) {
    return invoices.byCustomer(customer);
  }

  @POST
  @Consumes(MediaType.APPLICATION_JSON)
  public Response create(Invoice invoice) {
    invoices.save(invoice);
    return Response.status(Response.Status.CREATED).build();
  }
}
