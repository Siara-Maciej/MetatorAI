package com.example.shop.reactive;

import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

@Configuration
public class ProductRoutes {
  @Bean
  public RouterFunction<ServerResponse> productRoutes(ProductHandler handler) {
    return route()
        .GET("/fn/products", handler::list)
        .POST("/fn/products", handler::create)
        .build();
  }

  @Bean
  public RouterFunction<ServerResponse> healthRoute(ProductHandler handler) {
    return RouterFunctions.route(GET("/fn/health"), handler::health);
  }
}
