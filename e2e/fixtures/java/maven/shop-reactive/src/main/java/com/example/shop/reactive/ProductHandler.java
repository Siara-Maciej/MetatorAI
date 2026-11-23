package com.example.shop.reactive;

import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

@Component
public class ProductHandler {
  private final ProductCatalog catalog;

  public ProductHandler(ProductCatalog catalog) {
    this.catalog = catalog;
  }

  public Mono<ServerResponse> list(ServerRequest request) {
    return ServerResponse.ok().body(catalog.all(), ProductView.class);
  }

  public Mono<ServerResponse> create(ServerRequest request) {
    return ServerResponse.accepted().build();
  }

  public Mono<ServerResponse> health(ServerRequest request) {
    return ServerResponse.ok().bodyValue("up");
  }
}
